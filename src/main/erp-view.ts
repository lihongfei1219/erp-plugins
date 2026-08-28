import { BrowserWindow, WebContentsView } from 'electron'
import type { ErpConfig } from './erp-config'
import {
  buildExtractedAutofillScript,
  buildMockAutofillScript,
  createAutofillFailure
} from './erp-autofill'
import type { ErpAutofillResult, ErpState } from '../shared/erp'
import type { UnitInitialApprovalExtraction } from '../shared/ocr'

const TOOLBAR_HEIGHT = 64
const SIDEBAR_WIDTH = 360

export class ErpViewController {
  private readonly view: WebContentsView | null
  private state: ErpState

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
      message: config.url ? null : '请在 .env 中配置 MAIN_VITE_ERP_URL'
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

  setVisible(visible: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return
    }

    if (visible) {
      this.updateBounds()
    }

    this.view.setVisible(visible)
  }

  async fillMockData(): Promise<ErpAutofillResult> {
    return this.fillWithScript(buildMockAutofillScript())
  }

  async fillExtractedData(
    extraction: UnitInitialApprovalExtraction
  ): Promise<ErpAutofillResult> {
    return this.fillWithScript(buildExtractedAutofillScript(extraction))
  }

  private async fillWithScript(script: string): Promise<ErpAutofillResult> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return createAutofillFailure('unavailable', 'ERP 页面尚未加载')
    }

    const contents = this.view.webContents
    const frames = [contents.mainFrame, ...contents.mainFrame.frames]
    const editorFrame = frames.find((frame) => {
      try {
        const url = new URL(frame.url)
        return (
          this.isAllowedUrl(frame.url) &&
          url.pathname.toLowerCase() === '/zhidan/zhidan.aspx' &&
          url.searchParams.get('Type')?.toLowerCase() === 'add'
        )
      } catch {
        return false
      }
    })

    if (!editorFrame) {
      return createAutofillFailure(
        'wrong-page',
        '请先进入“购货首营管理 → 单位首营审批”，点击“新建”后再代填'
      )
    }

    try {
      const isExpectedForm = await editorFrame.executeJavaScript(
        `document.title.includes('单位首营审批') && Boolean(document.getElementById('DWMC')) && Boolean(document.getElementById('YYZZH'))`,
        true
      )

      if (!isExpectedForm) {
        return createAutofillFailure('wrong-page', '当前新建页不是可识别的单位首营审批表单')
      }

      const result = (await editorFrame.executeJavaScript(
        script,
        true
      )) as {
        filledHeaderFields?: unknown
        filledQualificationRows?: unknown
        skippedFields?: unknown
      }

      if (
        typeof result?.filledHeaderFields !== 'number' ||
        typeof result?.filledQualificationRows !== 'number' ||
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
        message: `已填入 ${result.filledHeaderFields} 个基本字段和 ${result.filledQualificationRows} 条证照${skippedMessage}；请核对后手动保存`,
        filledHeaderFields: result.filledHeaderFields,
        filledQualificationRows: result.filledQualificationRows,
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
      width: Math.max(0, width - SIDEBAR_WIDTH),
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
    })

    contents.on('did-stop-loading', () => {
      this.refreshNavigationState('ready')
    })

    contents.on('did-navigate', () => {
      this.refreshNavigationState()
    })

    contents.on('did-navigate-in-page', () => {
      this.refreshNavigationState()
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

  private patchState(patch: Partial<ErpState>): void {
    this.state = {
      ...this.state,
      ...patch
    }

    this.onStateChanged(this.getState())
  }
}
