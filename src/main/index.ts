import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { loadErpConfig } from './erp-config'
import { ErpViewController } from './erp-view'
import { ERP_IPC, type ErpState } from '../shared/erp'
import type { ErpBusinessRequest, ErpFillSessionRequest } from '../shared/erp'
import type { BusinessId } from '../shared/business'
import type { DocumentExtractionClient } from './document-extraction-client'
import { createDocumentExtractionClient } from './extraction-client-factory'
import {
  OCR_IPC,
  type OcrCancelRequest,
  type OcrDocumentSelectionRequest,
  type OcrExtractionRequest
} from '../shared/ocr'
import { createLocalDocumentPreview } from './agent/document-images'
import { normalizeExcludedPages } from './page-selection'
import { WorkflowSessionManager } from './workflow-session-manager'

const LOCAL_PREVIEW_MAX_BYTES = 100 * 1024 * 1024
const LOCAL_PREVIEW_MAX_PAGES = 50

function loadLocalEnvironment(): void {
  try {
    process.loadEnvFile(join(process.cwd(), '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('读取本地 .env 失败', error)
    }
  }
}

loadLocalEnvironment()

let mainWindow: BrowserWindow | null = null
let erpController: ErpViewController | null = null
let ocrClient: DocumentExtractionClient | null = null
const workflowSessions = new WorkflowSessionManager()

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  erpController = new ErpViewController(mainWindow, loadErpConfig(), (state) => {
    mainWindow?.webContents.send(ERP_IPC.stateChanged, state)
  })

  mainWindow.on('closed', () => {
    erpController?.dispose()
    erpController = null
    workflowSessions.clear()
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function assertTrustedShell(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('拒绝来自非客户端界面的 IPC 请求')
  }
}

function emptyErpState(): ErpState {
  return {
    configured: false,
    status: 'not-configured',
    url: null,
    canGoBack: false,
    canGoForward: false,
    message: 'ERP 视图尚未初始化',
    currentPage: null
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

function ensureCurrentBusiness(businessId: BusinessId): void {
  const page = erpController?.getState().currentPage
  if (!page || !page.isNew || page.businessId !== businessId) {
    throw new Error('当前 ERP 新建页面与所选业务不一致')
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(ERP_IPC.getState, (event) => {
    assertTrustedShell(event)
    return erpController?.getState() ?? emptyErpState()
  })

  ipcMain.handle(ERP_IPC.goBack, (event) => {
    assertTrustedShell(event)
    erpController?.goBack()
  })

  ipcMain.handle(ERP_IPC.goForward, (event) => {
    assertTrustedShell(event)
    erpController?.goForward()
  })

  ipcMain.handle(ERP_IPC.reload, (event) => {
    assertTrustedShell(event)
    erpController?.reload()
  })

  ipcMain.handle(ERP_IPC.setAssistantWidth, (event, value: unknown) => {
    assertTrustedShell(event)
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    erpController?.setAssistantWidth(value)
  })

  ipcMain.handle(ERP_IPC.fillFixture, async (event, value: unknown) => {
    assertTrustedShell(event)

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
      ensureCurrentBusiness(request.businessId)
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
    assertTrustedShell(event)
    try {
      if (!value || typeof value !== 'object') throw new Error('代填请求无效')
      const request = value as Partial<ErpFillSessionRequest>
      if (!isBusinessId(request.businessId) || typeof request.sessionId !== 'string') {
        throw new Error('代填会话无效')
      }
      ensureCurrentBusiness(request.businessId)
      if (!erpController) throw new Error('ERP 视图尚未初始化')
      const extraction = workflowSessions.getExtraction(request.sessionId, request.businessId)
      return erpController.fillExtractedData(request.businessId, extraction)
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
    assertTrustedShell(event)
    erpController?.setVisible(true)
    if (!value || typeof value !== 'object') {
      return { status: 'failed', message: '文件选择请求无效', preview: null }
    }
    const request = value as Partial<OcrDocumentSelectionRequest>
    if (typeof request.sessionId !== 'string' || !isBusinessId(request.businessId)) {
      return { status: 'failed', message: '业务会话无效', preview: null }
    }
    try {
      ensureCurrentBusiness(request.businessId)
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
      return { status: 'cancelled', message: '已取消选择', preview: null }
    }

    const filePath = selection.filePaths[0]
    try {
      const localPreview = await createLocalDocumentPreview(
        filePath,
        LOCAL_PREVIEW_MAX_BYTES,
        LOCAL_PREVIEW_MAX_PAGES,
        (current, total) => {
          mainWindow?.webContents.send(OCR_IPC.progress, {
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
    assertTrustedShell(event)
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
    assertTrustedShell(event)
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
    if (
      typeof candidate.sessionId !== 'string' ||
      !isBusinessId(candidate.businessId) ||
      typeof candidate.token !== 'string'
    ) return { status: 'failed', message: '识别会话无效', result: null }

    let selection
    try {
      ensureCurrentBusiness(candidate.businessId)
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
        mainWindow?.webContents.send(OCR_IPC.progress, {
          ...progress,
          sessionId: selection.sessionId,
          businessId: selection.businessId
        })
      },
      { businessId: selection.businessId, excludedPages }
    )
    if (result.status === 'completed' && result.result?.extractedData) {
      workflowSessions.complete(
        selection.sessionId,
        selection.businessId,
        result.result.extractedData
      )
    }
    return result
  })
}

app.whenReady().then(() => {
  ocrClient = createDocumentExtractionClient()
  registerIpcHandlers()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
