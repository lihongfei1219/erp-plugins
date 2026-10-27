import { dialog, ipcMain } from 'electron'
import type { WindowManager, WorkWindow } from './window-manager'
import type { PurchaseQueueManager } from './purchase-queue'
import { BUSINESS_DEFINITIONS } from '../shared/business'
import { isQueueBusiness, PURCHASE_QUEUE_IPC } from '../shared/purchase-queue'
import { createAutofillFailure } from './erp-autofill'
import { prepareDocument } from './agent/document-images'
import { takeDroppedFiles } from './file-drop'

function ownerOf(context: WorkWindow): string {
  context.lifetime.signal.throwIfAborted()
  context.erpController.assertAccountReady()
  if (!context.purchaseQueueOwner || !context.accountId) {
    throw new Error('请在账号管理中保存账号并打开其工作窗口，以便隔离票据')
  }
  return context.purchaseQueueOwner
}

function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new Error('票据任务无效')
  return value
}

export function registerPurchaseQueueIpc(windows: WindowManager, queue: PurchaseQueueManager): void {
  const previewVersions = new WeakMap<WorkWindow, number>()
  const observedPreviews = new WeakSet<WorkWindow>()
  const closePreview = (context: WorkWindow): void => {
    previewVersions.set(context, (previewVersions.get(context) ?? 0) + 1)
    context.erpController.setVisible(true)
  }
  const observePreviewLifetime = (context: WorkWindow): void => {
    if (observedPreviews.has(context)) return
    observedPreviews.add(context)
    // Renderer teardown can skip its cleanup hooks. Restore the native view and
    // invalidate any still-rendering image before a replacement shell is loaded.
    context.mainWindow.webContents.on('render-process-gone', () => closePreview(context))
    context.mainWindow.webContents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) closePreview(context)
    })
  }
  ipcMain.handle(PURCHASE_QUEUE_IPC.list, event => {
    const context = windows.fromEvent(event)
    if (!context.purchaseQueueOwner || context.erpController.getState().account?.status !== 'signed-in') return []
    return queue.list(ownerOf(context))
  })
  ipcMain.handle(PURCHASE_QUEUE_IPC.get, (event, id: unknown) =>
    queue.get(ownerOf(windows.fromEvent(event)), taskId(id)))

  ipcMain.handle(PURCHASE_QUEUE_IPC.add, async (event, requestedBusiness: unknown, dropToken: unknown) => {
    const context = windows.fromEvent(event)
    const owner = ownerOf(context)
    await context.erpController.refreshPageContext()
    const businessId = context.erpController.getState().currentPage?.businessId
    if (!isQueueBusiness(businessId) || (requestedBusiness !== undefined && requestedBusiness !== businessId)) {
      throw new Error('请进入对应的采购订单或商品收货登记页面后添加票据')
    }
    if (dropToken !== undefined) {
      const paths = takeDroppedFiles(context, dropToken, businessId)
      return queue.enqueue(owner, paths, businessId)
    }
    const selection = await dialog.showOpenDialog(context.mainWindow, {
      title: `批量选择${BUSINESS_DEFINITIONS[businessId].name}票据（每个文件对应一张单据）`,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '票据图片或 PDF', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp', 'pdf'] }]
    })
    if (selection.canceled) return { added: [], errors: [] }
    ownerOf(context)
    return queue.enqueue(owner, selection.filePaths, businessId)
  })

  for (const operation of ['retry', 'cancel', 'remove', 'resetUsage'] as const) {
    ipcMain.handle(PURCHASE_QUEUE_IPC[operation], (event, id: unknown) => {
      const owner = ownerOf(windows.fromEvent(event))
      queue[operation](owner, taskId(id))
    })
  }

  ipcMain.handle(PURCHASE_QUEUE_IPC.fill, async (event, value: unknown) => {
    const context = windows.fromEvent(event)
    let started: { owner: string; id: string } | null = null
    try {
      const owner = ownerOf(context)
      if (!value || typeof value !== 'object') throw new Error('代填请求无效')
      const request = value as { taskId?: unknown; pageId?: unknown }
      const id = taskId(request.taskId)
      if (typeof request.pageId !== 'string' || !request.pageId) throw new Error('请先新建对应业务的单据')
      await context.erpController.refreshPageContext()
      ownerOf(context)
      const page = context.erpController.getState().currentPage
      if (!page?.isNew || !isQueueBusiness(page.businessId) || page.pageId !== request.pageId) {
        throw new Error('当前页面已切换，请进入对应的新建单据后再代填')
      }
      const before = queue.get(owner, id)
      if (before.businessId !== page.businessId) throw new Error('识别结果与当前业务不一致，已拒绝代填')
      if (before.boundPageId !== page.pageId) await context.erpController.assertQueuePageEmpty(page.businessId, page.pageId)
      ownerOf(context)
      const detail = queue.beginFill(owner, id, page.pageId, page.businessId)
      started = { owner, id }
      const extraction = detail.result?.extractedData
      if (!extraction || extraction.documentType !== page.businessId || !extraction.readyForAutofill) {
        throw new Error('这张票据的识别结果尚不可代填，请先核对')
      }
      // Keep existing session/page guards. The durable queue is never stored in this page session.
      const sessionId = `purchase-queue:${id}:${page.pageId}`
      try { context.workflowSessions.getPageId(sessionId, page.businessId) }
      catch { context.workflowSessions.bindToPage(sessionId, page.businessId, page.pageId) }
      context.workflowSessions.complete(sessionId, page.businessId, extraction)
      const result = await context.erpController.fillExtractedData(page.businessId,
        context.workflowSessions.getExtraction(sessionId, page.businessId), page.pageId)
      queue.finishFill(owner, id, result)
      started = null
      return result
    } catch (error) {
      const result = createAutofillFailure('failed', error instanceof Error ? error.message : '票据代填失败')
      if (started) {
        try { queue.finishFill(started.owner, started.id, result) }
        catch { /* A persisted filling intent will recover as uncertain on restart. */ }
      }
      return result
    }
  })

  ipcMain.handle(PURCHASE_QUEUE_IPC.preview, async (event, id: unknown) => {
    const context = windows.fromEvent(event)
    const owner = ownerOf(context)
    observePreviewLifetime(context)
    const version = (previewVersions.get(context) ?? 0) + 1
    previewVersions.set(context, version)
    const detail = queue.get(owner, taskId(id))
    const document = await prepareDocument(queue.sourcePath(owner, detail.taskId), 100 * 1024 * 1024, 50)
    try {
      const pages: { pageNumber: number; thumbnailDataUrl: string }[] = []
      for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber++) {
        ownerOf(context)
        if (previewVersions.get(context) !== version) throw new Error('原图预览已关闭')
        const rendered = await document.renderPage(pageNumber, { maxDimension: 1800, jpegQuality: 88 })
        pages.push({ pageNumber, thumbnailDataUrl: `data:${rendered.mimeType};base64,${rendered.data}` })
      }
      ownerOf(context)
      if (previewVersions.get(context) !== version) throw new Error('原图预览已关闭')
      context.erpController.setVisible(false)
      return { fileName: detail.fileName, pageCount: document.pageCount, pages }
    } finally { await document.dispose() }
  })
  ipcMain.handle(PURCHASE_QUEUE_IPC.closePreview, event => {
    const context = windows.fromEvent(event)
    closePreview(context)
  })
}
