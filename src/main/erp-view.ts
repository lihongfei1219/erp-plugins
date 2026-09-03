import { BrowserWindow, WebContentsView } from 'electron'
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

const TOOLBAR_HEIGHT = 64
const DEFAULT_SIDEBAR_WIDTH = 400

export class ErpViewController {
  private readonly view: WebContentsView | null
  private state: ErpState
  private assistantWidth = DEFAULT_SIDEBAR_WIDTH
  private pageDetectionVersion = 0

  constructor(
    private readonly window: BrowserWindow,
    private readonly config: ErpConfig,
    private readonly onStateChanged: (state: ErpState) => void
  ) {
    this.state = {
      configured: config.url !== null,
      status: config.url ? 'loading' : 'not-configured',
      url: config.url?.toString() ?? null,
      canGoBack: false,
      canGoForward: false,
      message: config.url ? null : '请在 .env 中配置 MAIN_VITE_ERP_URL',
      currentPage: null
    }

    if (!config.url) {
      this.view = null
      return
    }

    this.view = new WebContentsView({
      webPreferences: {
        partition: 'persist:erp-session',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    this.window.contentView.addChildView(this.view)
    this.configureSecurity()
    this.registerEvents()
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

  async fillExtractedData(
    businessId: BusinessId,
    extraction: BusinessExtraction
  ): Promise<ErpAutofillResult> {
    if (extraction.documentType !== businessId) {
      return createAutofillFailure('failed', '识别结果与当前业务不一致，已拒绝代填')
    }
    return this.fillWithScript(businessId, buildExtractedAutofillScript(extraction))
  }

  private async fillWithScript(
    businessId: BusinessId,
    script: string
  ): Promise<ErpAutofillResult> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return createAutofillFailure('unavailable', 'ERP 页面尚未加载')
    }

    const detected = await this.findBusinessFrame(businessId)
    const editorFrame = detected?.frame

    if (!editorFrame) {
      const definition = BUSINESS_DEFINITIONS[businessId]
      return createAutofillFailure(
        'wrong-page',
        `请先进入“${definition.moduleName} → ${definition.name}”的新建页面后再代填`
      )
    }

    try {
      const result = (await editorFrame.executeJavaScript(
        script,
        true
      )) as {
        filledHeaderFields?: unknown
        filledDetailRows?: unknown
        skippedFields?: unknown
      }

      if (
        typeof result?.filledHeaderFields !== 'number' ||
        typeof result?.filledDetailRows !== 'number' ||
        !Array.isArray(result?.skippedFields)
      ) {
        return createAutofillFailure('failed', 'ERP 页面没有返回有效的代填结果')
      }

      const skippedFields = result.skippedFields.filter(
        (value): value is string => typeof value === 'string'
      )
      const skippedMessage = skippedFields.length > 0 ? `，${skippedFields.length} 项未填` : ''

      return {
        status: 'filled',
        message: `已填入 ${result.filledHeaderFields} 个基本字段和 ${result.filledDetailRows} 条明细${skippedMessage}；请核对后手动保存`,
        filledHeaderFields: result.filledHeaderFields,
        filledDetailRows: result.filledDetailRows,
        skippedFields
      }
    } catch (error) {
      return createAutofillFailure(
        'failed',
        error instanceof Error ? `代填失败：${error.message}` : '代填失败：未知错误'
      )
    }
  }

  dispose(): void {
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

  private async refreshPageContext(): Promise<void> {
    const detectionVersion = ++this.pageDetectionVersion
    const detected = await this.findBusinessFrame()
    if (detectionVersion !== this.pageDetectionVersion) return
    const currentPage = detected?.context ?? null
    if (JSON.stringify(currentPage) !== JSON.stringify(this.state.currentPage)) {
      this.patchState({ currentPage })
    }
  }

  private async findBusinessFrame(
    expectedBusinessId?: BusinessId
  ): Promise<{ frame: Electron.WebFrameMain; context: ErpPageContext } | null> {
    if (!this.view || this.view.webContents.isDestroyed()) return null
    const contents = this.view.webContents
    const frames = [contents.mainFrame, ...contents.mainFrame.frames]

    const candidates: Array<{ frame: Electron.WebFrameMain; context: ErpPageContext; visible: boolean }> = []
    for (const frame of frames) {
      if (!this.isAllowedUrl(frame.url)) continue
      let descriptor: ErpPageDescriptor | null = null
      try {
        descriptor = (await frame.executeJavaScript(
          `(() => {
            const value = (id) => {
              const element = document.getElementById(id)
              return element && 'value' in element ? String(element.value || '').trim() : null
            }
            const knownIds = ['DWMC', 'YYZZH', 'QYRQ', 'CYDW', 'FKFS', 'SPMC']
            return {
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
      if (!context.supported || !context.isNew) continue
      if (expectedBusinessId && context.businessId !== expectedBusinessId) continue
      candidates.push({ frame, context, visible: descriptor.visible })
    }
    const active = candidates.find((candidate) => candidate.visible)
    return active ? { frame: active.frame, context: active.context } : null
  }

  private patchState(patch: Partial<ErpState>): void {
    this.state = {
      ...this.state,
      ...patch
    }

    this.onStateChanged(this.getState())
  }
}
