import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import { join } from 'node:path'
import { loadErpConfig } from './erp-config'
import { AccountStore } from './account-store'
import { WindowManager } from './window-manager'
import type { DocumentExtractionClient } from './document-extraction-client'
import { createDocumentExtractionClient } from './extraction-client-factory'
import { registerWorkflowIpc } from './workflow-ipc'
import { PurchaseQueueManager } from './purchase-queue'
import { registerPurchaseQueueIpc } from './purchase-queue-ipc'

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

let windows: WindowManager
let ocrClient: DocumentExtractionClient | null = null
let purchaseQueue: PurchaseQueueManager | null = null

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
else {
  app.on('second-instance', () => { windows?.openManager() })
  app.whenReady().then(() => {
    const accounts = new AccountStore(join(app.getPath('userData'), 'accounts.json'), {
      encrypt: value => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法加密密码，请稍后重试')
        return safeStorage.encryptString(value).toString('base64')
      },
      decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
    })
    windows = new WindowManager(accounts, loadErpConfig())
    ocrClient = createDocumentExtractionClient()
    purchaseQueue = new PurchaseQueueManager(join(app.getPath('userData'), 'purchase-queue'), ocrClient,
      owner => windows.sendPurchaseQueueChanged(owner))
    windows.attachPurchaseQueue(purchaseQueue)
    registerWorkflowIpc(windows, ocrClient)
    registerPurchaseQueueIpc(windows, purchaseQueue)
    windows.registerIpc()
    windows.openAll()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) windows.openAll()
    })
  }).catch(() => {
    dialog.showErrorBox('启动失败', '无法读取账号配置或初始化客户端，请保留用户数据目录中的 accounts.json 并检查配置。')
    app.quit()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { purchaseQueue?.shutdown() })
