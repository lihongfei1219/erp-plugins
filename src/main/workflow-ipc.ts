import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { ErpViewController } from './erp-view'
import type { WindowManager } from './window-manager'
import { ERP_IPC, type ErpState, type ErpBusinessRequest, type ErpFillSessionRequest } from '../shared/erp'
import type { BusinessId } from '../shared/business'
import type { DocumentExtractionClient } from './document-extraction-client'
import type { ActiveDocumentBatch } from './workflow-session-manager'
import { OCR_IPC, type OcrCancelRequest, type OcrDocumentSelectionRequest, type OcrExtractionRequest } from '../shared/ocr'
import { registerFileDropIpc, takeDroppedFiles } from './file-drop'
import { aggregateUnitDocumentBatch, friendlyBatchError } from './unit-document-batch'

const UNIT_BATCH_CONCURRENCY = 2

function emptyErpState(): ErpState {
  return {
    configured: false,
    status: 'not-configured',
    url: null,
    canGoBack: false,
    canGoForward: false,
    message: 'ERP 视图尚未初始化',
    currentPage: null,
    openPageIds: []
  }
}

function isBusinessId(value: unknown): value is BusinessId {
  return value === 'unit-initial-approval' ||
    value === 'goods-receipt' ||
    value === 'purchase-order'
}

function parseBusinessRequest(value: unknown): ErpBusinessRequest {
  if (!value || typeof value !== 'object') throw new Error('业务请求无效')
  const request = value as Partial<ErpBusinessRequest>
  if (!isBusinessId(request.businessId)) throw new Error('不支持的业务类型')
  return { businessId: request.businessId }
}

function ensureCurrentBusiness(erpController: ErpViewController, businessId: BusinessId): string {
  erpController.assertAccountReady()
  const page = erpController?.getState().currentPage
  if (!page || !page.isNew || page.businessId !== businessId || !page.pageId) {
    throw new Error('当前 ERP 新建页面与所选业务不一致')
  }
  return page.pageId
}

export function registerWorkflowIpc(windows: WindowManager, ocrClient: DocumentExtractionClient): void {
  registerFileDropIpc(windows)
  ipcMain.handle(ERP_IPC.getState, (event) => {
    const { erpController } = windows.fromEvent(event)
    return erpController?.getState() ?? emptyErpState()
  })

  ipcMain.handle(ERP_IPC.goBack, (event) => {
    const { erpController } = windows.fromEvent(event)
    erpController?.goBack()
  })

  ipcMain.handle(ERP_IPC.goForward, (event) => {
    const { erpController } = windows.fromEvent(event)
    erpController?.goForward()
  })

  ipcMain.handle(ERP_IPC.reload, (event) => {
    const { erpController } = windows.fromEvent(event)
    erpController?.reload()
  })

  ipcMain.handle(ERP_IPC.setAssistantWidth, (event, value: unknown) => {
    const { erpController } = windows.fromEvent(event)
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    erpController?.setAssistantWidth(value)
  })

  ipcMain.handle(ERP_IPC.fillFixture, async (event, value: unknown) => {
    const { erpController } = windows.fromEvent(event)

    if (!erpController) {
      return {
        status: 'unavailable',
        message: 'ERP 视图尚未初始化',
        filledHeaderFields: 0,
        filledDetailRows: 0,
        skippedFields: []
      }
    }
    try {
      const request = parseBusinessRequest(value)
      if ((request.businessId === 'purchase-order' || request.businessId === 'goods-receipt')) throw new Error('采购订单和商品收货登记请从票据队列选择结果代填')
      ensureCurrentBusiness(erpController, request.businessId)
      return erpController.fillFixture(request.businessId)
    } catch (error) {
      return {
        status: 'wrong-page',
        message: error instanceof Error ? error.message : '测试数据与当前业务不一致',
        filledHeaderFields: 0,
        filledDetailRows: 0,
        skippedFields: []
      }
    }
  })

  ipcMain.handle(ERP_IPC.fillSession, async (event, value: unknown) => {
    const { erpController, workflowSessions } = windows.fromEvent(event)
    try {
      if (!value || typeof value !== 'object') throw new Error('代填请求无效')
      const request = value as Partial<ErpFillSessionRequest>
      if (!isBusinessId(request.businessId) || typeof request.sessionId !== 'string') {
        throw new Error('代填会话无效')
      }
      if ((request.businessId === 'purchase-order' || request.businessId === 'goods-receipt')) throw new Error('采购订单和商品收货登记请从票据队列选择结果代填')
      if (!erpController) throw new Error('ERP 视图尚未初始化')
      await erpController.refreshPageContext()
      const pageId = workflowSessions.getPageId(request.sessionId, request.businessId)
      if (ensureCurrentBusiness(erpController, request.businessId) !== pageId) throw new Error('暂存结果属于其他单据页')
      const extraction = workflowSessions.getExtraction(request.sessionId, request.businessId)
      return erpController.fillExtractedData(request.businessId, extraction, pageId)
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : '代填失败',
        filledHeaderFields: 0,
        filledDetailRows: 0,
        skippedFields: []
      }
    }
  })

  ipcMain.handle(OCR_IPC.selectDocument, async (event, value: unknown) => {
    const { mainWindow, erpController, workflowSessions } = windows.fromEvent(event)
    if (!value || typeof value !== 'object') {
      return { status: 'failed', message: '文件选择请求无效', batch: null }
    }
    const request = value as Partial<OcrDocumentSelectionRequest>
    if (
      request.businessId !== 'unit-initial-approval' ||
      typeof request.sessionId !== 'string' ||
      typeof request.pageId !== 'string'
    ) {
      return { status: 'failed', message: '单位首营资料只能在单位首营审批新建页面导入', batch: null }
    }
    if (!mainWindow || !erpController) {
      return { status: 'failed', message: '客户端窗口尚未初始化', batch: null }
    }

    try {
      await erpController.refreshPageContext()
      if (ensureCurrentBusiness(erpController, request.businessId) !== request.pageId) {
        throw new Error('请在单位首营审批新建页面选择或拖入资料')
      }
      workflowSessions.bindToPage(request.sessionId, request.businessId, request.pageId)
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : '当前页面不支持单位首营资料识别',
        batch: null
      }
    }

    let droppedPaths: string[] | undefined
    if (request.dropToken !== undefined) {
      try {
        droppedPaths = takeDroppedFiles(windows.fromEvent(event), request.dropToken, request.businessId)
      } catch (error) {
        workflowSessions.discard(request.sessionId)
        return { status: 'failed', message: error instanceof Error ? error.message : '拖入文件失败', batch: null }
      }
    }
    const selection = droppedPaths ? { canceled: false, filePaths: droppedPaths } : await dialog.showOpenDialog(mainWindow, {
      title: '选择单位首营资料（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: '单位首营资料',
        extensions: ['pdf', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp']
      }]
    })

    if (selection.canceled || selection.filePaths.length === 0) {
      workflowSessions.discard(request.sessionId)
      return { status: 'cancelled', message: '已取消选择', batch: null }
    }
    const filePaths = [...new Set(selection.filePaths)]
    if (filePaths.length > 500) {
      workflowSessions.discard(request.sessionId)
      return { status: 'failed', message: '每批最多导入 500 个单位资料文件', batch: null }
    }

    const token = randomUUID()
    const items = filePaths.map((filePath) => ({
      id: randomUUID(),
      filePath,
      fileName: basename(filePath),
      status: 'queued' as const,
      message: '等待识别',
      pageCount: null,
      result: null
    }))
    try {
      await erpController.refreshPageContext()
      if (ensureCurrentBusiness(erpController, request.businessId) !== request.pageId) {
        throw new Error('单位首营审批页面已切换，请重新导入资料')
      }
      workflowSessions.setPending({
        sessionId: request.sessionId,
        businessId: request.businessId,
        token,
        items
      })
      return {
        status: 'ready',
        message: `已导入 ${items.length} 个单位资料文件，正在开始识别`,
        batch: {
          sessionId: request.sessionId,
          businessId: request.businessId,
          token,
          items: items.map(({ id, fileName, status, message, pageCount }) => ({ id, fileName, status, message, pageCount }))
        }
      }
    } catch (error) {
      workflowSessions.discard(request.sessionId)
      return { status: 'failed', message: error instanceof Error ? error.message : '导入单位资料失败', batch: null }
    }
  })

  ipcMain.handle(OCR_IPC.cancelDocument, (event, value: unknown) => {
    const { workflowSessions } = windows.fromEvent(event)
    if (!value || typeof value !== 'object') return
    const request = value as Partial<OcrCancelRequest>
    if (
      request.businessId === 'unit-initial-approval' &&
      typeof request.sessionId === 'string' &&
      typeof request.token === 'string'
    ) workflowSessions.cancel(request.sessionId, request.token)
  })

  ipcMain.handle(OCR_IPC.extractDocument, async (event, request: unknown) => {
    const { erpController, workflowSessions, send } = windows.fromEvent(event)
    if (!request || typeof request !== 'object') {
      return { status: 'failed', message: '单位资料识别请求无效', result: null }
    }
    const candidate = request as Partial<OcrExtractionRequest>
    if (
      candidate.businessId !== 'unit-initial-approval' ||
      typeof candidate.sessionId !== 'string' ||
      typeof candidate.token !== 'string'
    ) return { status: 'failed', message: '单位资料识别会话无效', result: null }

    const startedAt = Date.now()
    let activeBatch: ActiveDocumentBatch
    try {
      await erpController?.refreshPageContext()
      if (
        !erpController ||
        ensureCurrentBusiness(erpController, candidate.businessId) !==
          workflowSessions.getPageId(candidate.sessionId, candidate.businessId)
      ) throw new Error('请保持在原单位首营审批新建页面完成识别')
      activeBatch = workflowSessions.beginPending(
        candidate.sessionId,
        candidate.businessId,
        candidate.token,
        candidate.retryFailed === true
      )
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : '单位资料识别会话已失效', result: null }
    }

    let nextIndex = 0
    let completedItems = 0
    let failedItems = 0
    const processNext = async (): Promise<void> => {
      while (nextIndex < activeBatch.items.length) {
        const item = activeBatch.items[nextIndex++]
        activeBatch.signal.throwIfAborted()
        send(OCR_IPC.progress, {
          sessionId: activeBatch.sessionId,
          businessId: activeBatch.businessId,
          stage: 'queued',
          current: completedItems + failedItems,
          total: activeBatch.items.length,
          message: `${item.fileName} 等待识别`,
          itemId: item.id,
          itemStatus: 'recognizing',
          fileName: item.fileName,
          completedItems,
          failedItems
        })

        let itemResult
        try {
          itemResult = await ocrClient.extractDocument(
            item.filePath,
            (progress) => send(OCR_IPC.progress, {
              ...progress,
              sessionId: activeBatch.sessionId,
              businessId: activeBatch.businessId,
              current: completedItems + failedItems,
              total: activeBatch.items.length,
              message: `${item.fileName}：${progress.message}`,
              itemId: item.id,
              itemStatus: 'recognizing',
              fileName: item.fileName,
              completedItems,
              failedItems
            }),
            { businessId: activeBatch.businessId, signal: activeBatch.signal }
          )
        } catch (error) {
          itemResult = {
            status: 'failed' as const,
            message: error instanceof Error ? error.message : '识别请求异常',
            result: null
          }
        }
        activeBatch.signal.throwIfAborted()
        const succeeded = itemResult.status === 'completed' && Boolean(itemResult.result?.extractedData)
        const message = succeeded ? itemResult.message : friendlyBatchError(itemResult.message)
        workflowSessions.recordPendingItem(
          activeBatch.sessionId,
          activeBatch.businessId,
          activeBatch.token,
          item.id,
          itemResult,
          message
        )
        if (succeeded) completedItems++
        else failedItems++
        send(OCR_IPC.progress, {
          sessionId: activeBatch.sessionId,
          businessId: activeBatch.businessId,
          stage: completedItems + failedItems === activeBatch.items.length ? 'completed' : 'extracting',
          current: completedItems + failedItems,
          total: activeBatch.items.length,
          message: succeeded ? `${item.fileName} 识别完成` : `${item.fileName}：${message}`,
          itemId: item.id,
          itemStatus: succeeded ? 'completed' : 'failed',
          fileName: item.fileName,
          completedItems,
          failedItems
        })
      }
    }

    try {
      await Promise.all(Array.from(
        { length: Math.min(UNIT_BATCH_CONCURRENCY, activeBatch.items.length) },
        () => processNext()
      ))
      const selection = workflowSessions.finishPending(
        activeBatch.sessionId,
        activeBatch.businessId,
        activeBatch.token
      )
      const result = aggregateUnitDocumentBatch(selection, Date.now() - startedAt)
      if (result.result?.extractedData) {
        workflowSessions.complete(activeBatch.sessionId, activeBatch.businessId, result.result.extractedData)
      }
      return result
    } catch (error) {
      if (activeBatch.signal.aborted) {
        return { status: 'cancelled', message: '单位首营页面已切换、关闭或识别已取消', result: null }
      }
      try { workflowSessions.finishPending(activeBatch.sessionId, activeBatch.businessId, activeBatch.token) } catch { /* Session has already been discarded. */ }
      return { status: 'failed', message: friendlyBatchError(error instanceof Error ? error.message : '批量识别失败'), result: null }
    }
  })
}
