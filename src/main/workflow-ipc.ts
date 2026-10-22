import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { ErpViewController } from './erp-view'
import type { WindowManager } from './window-manager'
import { ERP_IPC, type ErpState, type ErpBusinessRequest, type ErpFillSessionRequest } from '../shared/erp'
import type { BusinessId } from '../shared/business'
import type { DocumentExtractionClient } from './document-extraction-client'
import { OCR_IPC, type OcrCancelRequest, type OcrDocumentSelectionRequest, type OcrExtractionRequest } from '../shared/ocr'
import { createLocalDocumentPreview } from './agent/document-images'
import { normalizeExcludedPages } from './page-selection'

const LOCAL_PREVIEW_MAX_BYTES = 100 * 1024 * 1024
const LOCAL_PREVIEW_MAX_PAGES = 50

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
      if (request.businessId === 'purchase-order') throw new Error('采购订单请从票据队列选择结果代填')
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
      if (request.businessId === 'purchase-order') throw new Error('采购订单请从票据队列选择结果代填')
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
    const { mainWindow, erpController, workflowSessions, send } = windows.fromEvent(event)
    erpController?.setVisible(true)
    if (!value || typeof value !== 'object') {
      return { status: 'failed', message: '文件选择请求无效', preview: null }
    }
    const request = value as Partial<OcrDocumentSelectionRequest>
    if (request.businessId === 'purchase-order') return { status: 'failed', message: '采购订单请使用批量票据队列', preview: null }
    if (typeof request.sessionId !== 'string' || !isBusinessId(request.businessId) || typeof request.pageId !== 'string') {
      return { status: 'failed', message: '业务会话无效', preview: null }
    }
    try {
      await erpController?.refreshPageContext()
      if (ensureCurrentBusiness(erpController, request.businessId) !== request.pageId) throw new Error('当前单据页已切换，请重新选择票据')
      workflowSessions.bindToPage(request.sessionId, request.businessId, request.pageId)
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : '当前页面不支持票据识别',
        preview: null
      }
    }
    workflowSessions.cancel(request.sessionId)
    if (!mainWindow) {
      return { status: 'failed', message: '客户端窗口尚未初始化', preview: null }
    }

    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择需要识别的票据',
      properties: ['openFile'],
      filters: [
        {
          name: '票据文件',
          extensions: ['pdf', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp']
        }
      ]
    })

    if (selection.canceled || selection.filePaths.length === 0) {
      workflowSessions.discard(request.sessionId)
      return { status: 'cancelled', message: '已取消选择', preview: null }
    }

    const filePath = selection.filePaths[0]
    try {
      const localPreview = await createLocalDocumentPreview(
        filePath,
        LOCAL_PREVIEW_MAX_BYTES,
        LOCAL_PREVIEW_MAX_PAGES,
        (current, total) => {
          send(OCR_IPC.progress, {
            sessionId: request.sessionId,
            businessId: request.businessId,
            stage: 'rendering',
            current,
            total,
            message: `正在本地生成页面预览 ${current}/${total}`
          })
        }
      )
      const token = randomUUID()
      await erpController?.refreshPageContext()
      workflowSessions.setPending({
        sessionId: request.sessionId,
        businessId: request.businessId,
        token,
        filePath,
        pageCount: localPreview.pageCount
      })
      // WebContentsView is composed above renderer DOM regardless of z-index.
      // Hide it while the local privacy-selection modal is visible.
      erpController?.setVisible(false)
      return {
        status: 'ready',
        message: `已在本地生成 ${localPreview.pageCount} 页预览，请排除高敏页面`,
        preview: {
          sessionId: request.sessionId,
          businessId: request.businessId,
          token,
          fileName: basename(filePath),
          pageCount: localPreview.pageCount,
          pages: localPreview.pages
        }
      }
    } catch (error) {
      erpController?.setVisible(true)
      const message = error instanceof Error ? error.message : '生成本地页面预览失败'
      return { status: 'failed', message, preview: null }
    }
  })

  ipcMain.handle(OCR_IPC.cancelDocument, (event, value: unknown) => {
    const { erpController, workflowSessions } = windows.fromEvent(event)
    erpController?.setVisible(true)
    if (!value || typeof value !== 'object') return
    const request = value as Partial<OcrCancelRequest>
    if (
      typeof request.sessionId === 'string' &&
      isBusinessId(request.businessId) &&
      typeof request.token === 'string'
    ) workflowSessions.cancel(request.sessionId, request.token)
  })

  ipcMain.handle(OCR_IPC.extractDocument, async (event, request: unknown) => {
    const { mainWindow, erpController, workflowSessions, lifetime, send } = windows.fromEvent(event)
    // The renderer closes the preview before extraction starts. Restore the
    // native ERP view for both normal extraction and validation-error paths.
    erpController?.setVisible(true)
    if (!mainWindow || !ocrClient) {
      return { status: 'failed', message: 'OCR客户端尚未初始化', result: null }
    }
    if (!request || typeof request !== 'object') {
      return { status: 'failed', message: '页面筛选请求无效', result: null }
    }

    const candidate = request as Partial<OcrExtractionRequest>
    if (candidate.businessId === 'purchase-order') return { status: 'failed', message: '采购订单请使用批量票据队列', result: null }
    if (
      typeof candidate.sessionId !== 'string' ||
      !isBusinessId(candidate.businessId) ||
      typeof candidate.token !== 'string'
    ) return { status: 'failed', message: '识别会话无效', result: null }

    let selection
    try {
      await erpController?.refreshPageContext()
      if (ensureCurrentBusiness(erpController, candidate.businessId) !== workflowSessions.getPageId(candidate.sessionId, candidate.businessId)) {
        throw new Error('票据预览属于其他单据页')
      }
      selection = workflowSessions.takePending(
        candidate.sessionId,
        candidate.businessId,
        candidate.token
      )
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : '文件选择已失效，请重新选择票据',
        result: null
      }
    }

    let excludedPages: number[]
    try {
      excludedPages = normalizeExcludedPages(candidate.excludedPages, selection.pageCount)
      if (excludedPages.length >= selection.pageCount) {
        throw new Error('至少需要保留一页用于识别')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '排除页码无效'
      return { status: 'failed', message, result: null }
    }

    // A selection token is single-use and the renderer never receives the
    // original local file path.
    const result = await ocrClient.extractDocument(
      selection.filePath,
      (progress) => {
        send(OCR_IPC.progress, {
          ...progress,
          sessionId: selection.sessionId,
          businessId: selection.businessId
        })
      },
      { businessId: selection.businessId, excludedPages, signal: lifetime.signal }
    )
    if (result.status === 'completed' && result.result?.extractedData) {
      await erpController?.refreshPageContext()
      try {
        workflowSessions.complete(
          selection.sessionId,
          selection.businessId,
          result.result.extractedData
        )
      } catch {
        return { status: 'failed', message: '原单据页已关闭，识别结果已丢弃', result: null }
      }
    }
    return result
  })
}
