import type { BusinessExtraction, BusinessId } from '../shared/business'
import type { OcrClientResult, OcrDocumentBatchItem } from '../shared/ocr'

export interface PendingDocumentItem extends OcrDocumentBatchItem {
  filePath: string
  result: OcrClientResult | null
}

export interface PendingDocumentSelection {
  sessionId: string
  businessId: BusinessId
  token: string
  items: PendingDocumentItem[]
}

export interface ActiveDocumentBatch extends PendingDocumentSelection {
  signal: AbortSignal
}

interface StoredDocumentSelection extends PendingDocumentSelection {
  running: boolean
  controller: AbortController
}

interface CompletedWorkflowSession {
  businessId: BusinessId
  extraction: BusinessExtraction
}

export class WorkflowSessionManager {
  private readonly pageBindings = new Map<string, { businessId: BusinessId; pageId: string }>()
  private readonly pendingSelections = new Map<string, StoredDocumentSelection>()
  private readonly completedSessions = new Map<string, CompletedWorkflowSession>()

  bindToPage(sessionId: string, businessId: BusinessId, pageId: string): void {
    if (this.pageBindings.has(sessionId)) throw new Error('会话已绑定单据页，请创建新会话')
    this.pageBindings.set(sessionId, { businessId, pageId })
  }

  getPageId(sessionId: string, businessId: BusinessId): string {
    const binding = this.pageBindings.get(sessionId)
    if (!binding) throw new Error('单据页已关闭或会话已失效，请重新识别')
    if (binding.businessId !== businessId) throw new Error('会话属于其他业务')
    return binding.pageId
  }

  retainOpenPages(pageIds: string[]): void {
    const open = new Set(pageIds)
    for (const [sessionId, binding] of this.pageBindings) {
      if (!open.has(binding.pageId)) this.discard(sessionId)
    }
  }

  cancelRunningOutsidePage(activePageId: string): void {
    for (const [sessionId, selection] of this.pendingSelections) {
      const binding = this.pageBindings.get(sessionId)
      if (selection.running && binding?.pageId !== activePageId) this.discard(sessionId)
    }
  }

  discard(sessionId: string): void {
    this.pendingSelections.get(sessionId)?.controller.abort(new Error('原单据页已关闭'))
    this.pageBindings.delete(sessionId)
    this.pendingSelections.delete(sessionId)
    this.completedSessions.delete(sessionId)
  }

  setPending(selection: PendingDocumentSelection): void {
    this.getPageId(selection.sessionId, selection.businessId)
    if (selection.items.length === 0) throw new Error('至少需要选择一个单位资料文件')
    this.pendingSelections.get(selection.sessionId)?.controller.abort(new Error('已选择新的单位资料'))
    this.pendingSelections.set(selection.sessionId, {
      ...selection,
      items: selection.items.map((item) => ({ ...item })),
      running: false,
      controller: new AbortController()
    })
    this.completedSessions.delete(selection.sessionId)
  }

  beginPending(
    sessionId: string,
    businessId: BusinessId,
    token: string,
    retryFailed = false
  ): ActiveDocumentBatch {
    this.getPageId(sessionId, businessId)
    const selection = this.pendingSelections.get(sessionId)
    if (!selection || selection.token !== token) {
      throw new Error('文件选择已失效，请重新选择单位资料')
    }
    if (selection.businessId !== businessId) throw new Error('当前资料属于其他业务，已拒绝跨业务识别')
    if (selection.running) throw new Error('当前单位资料正在识别，请勿重复提交')
    const selectedItems = selection.items.filter((item) => retryFailed ? item.status === 'failed' : item.status === 'queued')
    if (selectedItems.length === 0) {
      throw new Error(retryFailed ? '当前没有需要重试的失败文件' : '当前单位资料已经开始识别')
    }
    selection.running = true
    for (const item of selectedItems) {
      item.status = 'recognizing'
      item.message = '等待识别'
    }
    return {
      sessionId,
      businessId,
      token,
      items: selectedItems.map((item) => ({ ...item })),
      signal: selection.controller.signal
    }
  }

  recordPendingItem(
    sessionId: string,
    businessId: BusinessId,
    token: string,
    itemId: string,
    result: OcrClientResult,
    message: string
  ): void {
    this.getPageId(sessionId, businessId)
    const selection = this.pendingSelections.get(sessionId)
    if (!selection || selection.token !== token || selection.businessId !== businessId) {
      throw new Error('单位资料识别会话已失效')
    }
    const item = selection.items.find((candidate) => candidate.id === itemId)
    if (!item) throw new Error('单位资料文件不属于当前会话')
    item.status = result.status === 'completed' && result.result?.extractedData ? 'completed' : 'failed'
    item.message = message
    item.pageCount = result.result?.pageCount ?? item.pageCount
    item.result = result
  }

  finishPending(sessionId: string, businessId: BusinessId, token: string): PendingDocumentSelection {
    this.getPageId(sessionId, businessId)
    const selection = this.pendingSelections.get(sessionId)
    if (!selection || selection.token !== token || selection.businessId !== businessId) {
      throw new Error('单位资料识别会话已失效')
    }
    selection.running = false
    for (const item of selection.items) {
      if (item.status === 'recognizing') {
        item.status = 'failed'
        item.message = '识别任务中断，可单独重试该文件'
      }
    }
    return this.copySelection(selection)
  }

  getPending(sessionId: string, businessId: BusinessId, token: string): PendingDocumentSelection {
    this.getPageId(sessionId, businessId)
    const selection = this.pendingSelections.get(sessionId)
    if (!selection || selection.token !== token || selection.businessId !== businessId) {
      throw new Error('单位资料识别会话已失效')
    }
    return this.copySelection(selection)
  }

  cancel(sessionId: string, token?: string): void {
    const selection = this.pendingSelections.get(sessionId)
    if (!selection || (token && selection.token !== token)) return
    selection.controller.abort(new Error('识别任务已取消'))
    this.pendingSelections.delete(sessionId)
  }

  complete(sessionId: string, businessId: BusinessId, extraction: BusinessExtraction): void {
    if (extraction.documentType !== businessId) {
      throw new Error('识别结果与业务类型不一致，已拒绝保存到会话')
    }
    this.getPageId(sessionId, businessId)
    this.completedSessions.set(sessionId, { businessId, extraction })
  }

  getExtraction(sessionId: string, businessId: BusinessId): BusinessExtraction {
    const session = this.completedSessions.get(sessionId)
    if (!session) throw new Error('识别会话不存在或已失效')
    if (session.businessId !== businessId || session.extraction.documentType !== businessId) {
      throw new Error('识别结果属于其他业务，已拒绝跨业务代填')
    }
    return session.extraction
  }

  clear(): void {
    for (const selection of this.pendingSelections.values()) {
      selection.controller.abort(new Error('客户端窗口已关闭'))
    }
    this.pageBindings.clear()
    this.pendingSelections.clear()
    this.completedSessions.clear()
  }

  private copySelection(selection: StoredDocumentSelection): PendingDocumentSelection {
    return {
      sessionId: selection.sessionId,
      businessId: selection.businessId,
      token: selection.token,
      items: selection.items.map((item) => ({ ...item }))
    }
  }
}
