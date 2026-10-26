import { BrowserWindow, WebContentsView, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ErpConfig } from './erp-config'
import {
  buildExtractedAutofillScript,
  buildFixtureAutofillScript,
  createAutofillFailure
} from './erp-autofill'
import type { ErpAutofillResult, ErpState } from '../shared/erp'
import {
  BUSINESS_DEFINITIONS,
  type BusinessExtraction,
  type BusinessId,
  type ErpPageContext
} from '../shared/business'
import { toPageContext, type ErpPageDescriptor } from './businesses/page-registry'
import { normalizeAutofillResult } from './erp-autofill-result'
import { ErpLoginController } from './erp-login'
import type { AccountProfile } from '../shared/accounts'

export interface ErpWindowOptions {
  partition?: string
  account?: AccountProfile
  credentials?: () => { username: string; password: string }
}

const TOOLBAR_HEIGHT = 64
const DEFAULT_SIDEBAR_WIDTH = 400

export class ErpViewController {
  private readonly view: WebContentsView | null
  private state: ErpState
  private assistantWidth = DEFAULT_SIDEBAR_WIDTH
  private pageDetection: Promise<void> | null = null
  private pagePoll: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private login: ErpLoginController | null = null

  constructor(
    private readonly window: BrowserWindow,
    private readonly config: ErpConfig,
    private readonly onStateChanged: (state: ErpState) => void,
    options: ErpWindowOptions = {}
  ) {
    this.state = {
      configured: config.url !== null,
      status: config.url ? 'loading' : 'not-configured',
      url: config.url?.toString() ?? null,
      canGoBack: false,
      canGoForward: false,
      message: config.url ? null : '请在 .env 中配置 MAIN_VITE_ERP_URL',
      currentPage: null,
      openPageIds: []
    }

    if (!config.url) {
      this.view = null
      return
    }

    this.view = new WebContentsView({
      webPreferences: {
        partition: options.partition ?? 'persist:erp-session',
        preload: join(__dirname, '../preload/index.js'),
        additionalArguments: ['--erp-file-drop-only'],
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    this.window.contentView.addChildView(this.view)
    this.configureSecurity()
    this.registerEvents()
    if (options.account && options.credentials) {
      this.login = new ErpLoginController(this.view.webContents, config.url, options.account, options.credentials,
        account => this.patchState({ account }))
    }
    // ERP tab switches and iframe removal do not necessarily navigate.
    this.pagePoll = setInterval(() => { void this.refreshPageContext() }, 750)
    this.updateBounds()

    this.window.on('resize', this.updateBounds)

    void this.view.webContents.loadURL(config.url.toString()).catch((error: unknown) => {
      this.patchState({
        status: 'error',
        message: error instanceof Error ? error.message : 'ERP 页面加载失败'
      })
    })
  }

  getState(): ErpState {
    return { ...this.state }
  }

  acceptsFileDrop(event: Electron.IpcMainEvent): boolean {
    return Boolean(this.view && !this.disposed && event.sender === this.view.webContents &&
      event.senderFrame === this.view.webContents.mainFrame && this.isAllowedUrl(event.senderFrame.url))
  }

  retryLogin(): void { this.login?.retry() }

  assertAccountReady(): void {
    if (this.state.account && this.state.account.status !== 'signed-in') {
      throw new Error('请先完成当前预设账号的登录')
    }
  }

  goBack(): void {
    const history = this.view?.webContents.navigationHistory

    if (history?.canGoBack()) {
      history.goBack()
    }
  }

  goForward(): void {
    const history = this.view?.webContents.navigationHistory

    if (history?.canGoForward()) {
      history.goForward()
    }
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  setAssistantWidth(width: number): void {
    if (!Number.isFinite(width)) return
    this.assistantWidth = Math.max(56, Math.min(560, Math.round(width)))
    this.updateBounds()
  }

  setVisible(visible: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return
    }

    if (visible) {
      this.updateBounds()
    }

    this.view.setVisible(visible)
  }

  async fillFixture(businessId: BusinessId): Promise<ErpAutofillResult> {
    return this.fillWithScript(businessId, buildFixtureAutofillScript(businessId))
  }

  async assertPurchaseOrderEmpty(pageId: string): Promise<void> {
    return this.assertQueuePageEmpty('purchase-order', pageId)
  }

  async assertQueuePageEmpty(businessId: 'purchase-order' | 'goods-receipt', pageId: string): Promise<void> {
    this.assertAccountReady()
    const detected = await this.findBusinessFrame(businessId)
    if (!detected || detected.context.pageId !== pageId) throw new Error('单据页面已切换')
    const empty = await detected.frame.executeJavaScript(`(() => {
      if (document[Symbol.for('erp-ocr.document-id')] !== ${JSON.stringify(pageId)}) return false;
      const text = value => String(value ?? '').trim();
      if (['DWMC', 'DWBH'].some(id => text(document.getElementById(id)?.value))) return false;
      const grid = window.gridEditBody;
      if (!grid || typeof grid.getRows !== 'function') return false;
      return grid.getRows().every(row => {
        const cells = typeof row.cells === 'function' ? row.cells() : {};
        return ['SPBH', 'SPMC', 'GG', 'SCCS', 'SPPH'].every(key => {
          const cell = cells[key];
          return !text(typeof cell?.getValue === 'function' ? cell.getValue() : cell?.value);
        });
      });
    })()`, true)
    if (empty !== true) throw new Error('当前单据已有供应商或商品内容，请新建空白单据后使用这张票据')
  }

  async fillExtractedData(
    businessId: BusinessId,
    extraction: BusinessExtraction,
    pageId: string
  ): Promise<ErpAutofillResult> {
    if (extraction.documentType !== businessId) {
      return createAutofillFailure('failed', '识别结果与当前业务不一致，已拒绝代填')
    }
    const expectedRows = extraction.documentType === 'unit-initial-approval'
      ? extraction.qualificationRows.length : extraction.items.length
    return this.fillWithScript(businessId, buildExtractedAutofillScript(extraction), expectedRows, pageId)
  }

  private async fillWithScript(
    businessId: BusinessId,
    script: string,
    expectedDetailRows = 0,
    expectedPageId?: string
  ): Promise<ErpAutofillResult> {
    try { this.assertAccountReady() } catch (error) {
      return createAutofillFailure('unavailable', (error as Error).message)
    }
    if (!this.view || this.view.webContents.isDestroyed()) {
      return createAutofillFailure('unavailable', 'ERP 页面尚未加载')
    }

    const detected = await this.findBusinessFrame(businessId)
    const editorFrame = detected?.frame

    if (!editorFrame || (expectedPageId && detected.context.pageId !== expectedPageId)) {
      const definition = BUSINESS_DEFINITIONS[businessId]
      return createAutofillFailure(
        'wrong-page',
        `请先进入“${definition.moduleName} → ${definition.name}”的新建页面后再代填`
      )
    }

    try {
      const guardedScript = expectedPageId ? `(() => {
        if (document[Symbol.for('erp-ocr.document-id')] !== ${JSON.stringify(expectedPageId)}) {
          throw new Error('原单据页已关闭或刷新，暂存结果不可用于新页面')
        }
        return ${script}
      })()` : script
      const result = (await editorFrame.executeJavaScript(
        guardedScript,
        true
      )) as {
        filledHeaderFields?: unknown
        filledDetailRows?: unknown
        skippedFields?: unknown
      }

      return normalizeAutofillResult(result, expectedDetailRows)
    } catch (error) {
      return createAutofillFailure(
        'failed',
        error instanceof Error ? `代填失败：${error.message}` : '代填失败：未知错误'
      )
    }
  }

  dispose(): void {
    this.disposed = true
    this.login?.dispose()
    if (this.pagePoll) clearInterval(this.pagePoll)
    this.window.removeListener('resize', this.updateBounds)

    if (this.view && !this.view.webContents.isDestroyed()) {
      if (!this.window.isDestroyed()) {
        this.window.contentView.removeChildView(this.view)
      }

      this.view.webContents.close()
    }
  }

  private readonly updateBounds = (): void => {
    if (!this.view || this.window.isDestroyed()) {
      return
    }

    const [width, height] = this.window.getContentSize()

    this.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: Math.max(0, width - this.assistantWidth),
      height: Math.max(0, height - TOOLBAR_HEIGHT)
    })
  }

  private configureSecurity(): void {
    if (!this.view) {
      return
    }

    const contents = this.view.webContents

    const preventUnknownNavigation = (details: Electron.Event<Electron.WebContentsWillNavigateEventParams>): void => {
      if (!this.isAllowedUrl(details.url)) {
        details.preventDefault()
        this.patchState({ message: `已阻止跳转到未授权域名：${details.url}` })
      }
    }

    contents.on('will-navigate', preventUnknownNavigation)
    contents.on('will-redirect', preventUnknownNavigation)

    contents.setWindowOpenHandler(({ url }) => {
      this.patchState({ message: `已阻止新窗口：${url}` })
      return { action: 'deny' }
    })

    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })

    contents.session.setPermissionCheckHandler(() => false)
  }

  private registerEvents(): void {
    if (!this.view) {
      return
    }

    const contents = this.view.webContents

    contents.on('will-prevent-unload', (event) => {
      if (this.disposed || this.window.isDestroyed()) return
      // Electron cancels beforeunload navigation without a browser-style prompt.
      // The decision must be synchronous: preventDefault here allows leaving.
      const choice = dialog.showMessageBoxSync(this.window, {
        type: 'question',
        title: '确认离开 ERP 页面',
        message: 'ERP 页面正在阻止离开，是否继续？',
        detail: '可能有尚未保存的单据。选择“离开页面”将继续退出、刷新或跳转，并清除已关闭单据页的识别暂存；选择“留在当前页面”可继续核对和保存。',
        buttons: ['留在当前页面', '离开页面'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (choice === 1) event.preventDefault()
      else this.login?.cancelLogout()
    })

    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame) {
        this.patchState({ status: 'loading', message: null })
      }
    })

    contents.on('did-finish-load', () => {
      this.refreshNavigationState('ready')
      void this.refreshPageContext()
    })

    contents.on('did-stop-loading', () => {
      this.refreshNavigationState('ready')
      void this.refreshPageContext()
    })

    contents.on('did-navigate', () => {
      this.refreshNavigationState()
      void this.refreshPageContext()
    })

    contents.on('did-navigate-in-page', () => {
      this.refreshNavigationState()
      void this.refreshPageContext()
    })

    contents.on('did-frame-finish-load', () => {
      void this.refreshPageContext()
    })

    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
          return
        }

        this.patchState({
          status: 'error',
          url: validatedUrl || this.state.url,
          message: errorDescription
        })
      }
    )
  }

  private refreshNavigationState(status: ErpState['status'] = this.state.status): void {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return
    }

    const contents = this.view.webContents

    this.patchState({
      status,
      url: contents.getURL() || this.state.url,
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      message: status === 'ready' ? null : this.state.message
    })
  }

  private isAllowedUrl(value: string): boolean {
    try {
      return this.config.allowedOrigins.has(new URL(value).origin)
    } catch {
      return false
    }
  }

  async refreshPageContext(): Promise<void> {
    if (this.disposed) return
    if (this.pageDetection) return this.pageDetection
    this.pageDetection = this.updatePageContext().finally(() => { this.pageDetection = null })
    return this.pageDetection
  }

  private async updatePageContext(): Promise<void> {
    const candidates = await this.findBusinessFrames()
    if (this.disposed) return
    const currentPage = candidates.find(candidate => candidate.visible)?.context ?? null
    const openPageIds = candidates.flatMap(candidate => candidate.context.pageId ? [candidate.context.pageId] : [])
    if (JSON.stringify(currentPage) !== JSON.stringify(this.state.currentPage) ||
      JSON.stringify(openPageIds) !== JSON.stringify(this.state.openPageIds)) {
      this.patchState({ currentPage, openPageIds })
    }
  }

  private async findBusinessFrame(
    expectedBusinessId?: BusinessId
  ): Promise<{ frame: Electron.WebFrameMain; context: ErpPageContext } | null> {
    const candidates = await this.findBusinessFrames()
    const active = candidates.find(candidate => candidate.visible && candidate.context.isNew &&
      (!expectedBusinessId || candidate.context.businessId === expectedBusinessId))
    return active ? { frame: active.frame, context: active.context } : null
  }

  private async findBusinessFrames(): Promise<Array<{ frame: Electron.WebFrameMain; context: ErpPageContext; visible: boolean }>> {
    if (!this.view || this.view.webContents.isDestroyed()) return []
    const contents = this.view.webContents
    const frames = contents.mainFrame.framesInSubtree

    const candidates: Array<{ frame: Electron.WebFrameMain; context: ErpPageContext; visible: boolean }> = []
    for (const frame of frames) {
      if (!this.isAllowedUrl(frame.url)) continue
      let descriptor: ErpPageDescriptor | null = null
      try {
        descriptor = (await frame.executeJavaScript(
          `(() => {
            const pageKey = Symbol.for('erp-ocr.document-id')
            if (!document[pageKey]) Object.defineProperty(document, pageKey, { value: ${JSON.stringify(randomUUID())} })
            const value = (id) => {
              const element = document.getElementById(id)
              return element && 'value' in element ? String(element.value || '').trim() : null
            }
            const knownIds = ['DWMC', 'YYZZH', 'QYRQ', 'CYDW', 'FKFS', 'SPMC']
            return {
              pageId: document[pageKey],
              ename: value('Ename'),
              cname: value('Cname'),
              mode: value('Mode'),
              title: document.title || '',
              frameUrl: location.href,
              elementIds: knownIds.filter((id) => Boolean(document.getElementById(id))),
              visible: (() => {
                const element = window.frameElement
                if (!element) return true
                const style = getComputedStyle(element)
                const rect = element.getBoundingClientRect()
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
              })()
            }
          })()`,
          true
        )) as ErpPageDescriptor
      } catch {
        continue
      }

      const context = toPageContext(descriptor)
      if (!context.supported) continue
      candidates.push({ frame, context, visible: descriptor.visible })
    }
    return candidates
  }

  private patchState(patch: Partial<ErpState>): void {
    this.state = {
      ...this.state,
      ...patch
    }

    this.onStateChanged(this.getState())
  }
}
