import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { loadErpConfig } from './erp-config'
import { ErpViewController } from './erp-view'
import { ERP_IPC, type ErpState } from '../shared/erp'

let mainWindow: BrowserWindow | null = null
let erpController: ErpViewController | null = null

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
}

app.whenReady().then(() => {
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
