import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { loadErpConfig } from './erp-config'
import { ErpViewController } from './erp-view'
import { ERP_IPC, type ErpState } from '../shared/erp'
import type { DocumentExtractionClient } from './document-extraction-client'
import { createDocumentExtractionClient } from './extraction-client-factory'
import {
  OCR_IPC,
  type OcrExtractionRequest
} from '../shared/ocr'
import { createLocalDocumentPreview } from './agent/document-images'
import { normalizeExcludedPages } from './page-selection'

const LOCAL_PREVIEW_MAX_BYTES = 100 * 1024 * 1024
const LOCAL_PREVIEW_MAX_PAGES = 50

interface PendingDocumentSelection {
  token: string
  filePath: string
  pageCount: number
}

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
let pendingDocumentSelection: PendingDocumentSelection | null = null

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
    pendingDocumentSelection = null
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
    message: 'ERP 视图尚未初始化'
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

  ipcMain.handle(ERP_IPC.fillMockData, async (event) => {
    assertTrustedShell(event)

    if (!erpController) {
      return {
        status: 'unavailable',
        message: 'ERP 视图尚未初始化',
        filledHeaderFields: 0,
        filledQualificationRows: 0,
        skippedFields: []
      }
    }

    return erpController.fillMockData()
  })

  ipcMain.handle(OCR_IPC.selectDocument, async (event) => {
    assertTrustedShell(event)
    erpController?.setVisible(true)
    pendingDocumentSelection = null
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
            stage: 'rendering',
            current,
            total,
            message: `正在本地生成页面预览 ${current}/${total}`
          })
        }
      )
      const token = randomUUID()
      pendingDocumentSelection = {
        token,
        filePath,
        pageCount: localPreview.pageCount
      }
      // WebContentsView is composed above renderer DOM regardless of z-index.
      // Hide it while the local privacy-selection modal is visible.
      erpController?.setVisible(false)
      return {
        status: 'ready',
        message: `已在本地生成 ${localPreview.pageCount} 页预览，请排除高敏页面`,
        preview: {
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

  ipcMain.handle(OCR_IPC.cancelDocument, (event, token: unknown) => {
    assertTrustedShell(event)
    erpController?.setVisible(true)
    if (typeof token === 'string' && pendingDocumentSelection?.token === token) {
      pendingDocumentSelection = null
    }
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
    const selection = pendingDocumentSelection
    if (!selection || typeof candidate.token !== 'string' || candidate.token !== selection.token) {
      return { status: 'failed', message: '文件选择已失效，请重新选择票据', result: null }
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
    pendingDocumentSelection = null
    const result = await ocrClient.extractDocument(
      selection.filePath,
      (progress) => {
        mainWindow?.webContents.send(OCR_IPC.progress, progress)
      },
      { excludedPages },
      async ({ extraction }) => {
        if (!erpController) return
        await erpController.fillExtractedData(extraction)
      }
    )
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
