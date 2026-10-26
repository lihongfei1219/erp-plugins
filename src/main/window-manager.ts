import { BrowserWindow, ipcMain, screen, session, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { AccountStore, SavedBounds } from './account-store'
import { ACCOUNT_IPC } from '../shared/accounts'
import { ERP_IPC } from '../shared/erp'
import { PURCHASE_QUEUE_IPC } from '../shared/purchase-queue'
import type { PurchaseQueueManager } from './purchase-queue'
import type { ErpConfig } from './erp-config'
import { ErpViewController } from './erp-view'
import { WorkflowSessionManager } from './workflow-session-manager'

export interface WorkWindow {
  mainWindow: BrowserWindow
  erpController: ErpViewController
  workflowSessions: WorkflowSessionManager
  accountId: string | null
  purchaseQueueOwner: string | null
  lifetime: AbortController
  send: (channel: string, value: unknown) => void
}

export class WindowManager {
  private readonly windows = new Map<number, WorkWindow>()
  private manager: BrowserWindow | null = null
  private purchaseQueue: PurchaseQueueManager | null = null

  constructor(private readonly accounts: AccountStore, private readonly config: ErpConfig) {}

  attachPurchaseQueue(queue: PurchaseQueueManager): void { this.purchaseQueue = queue }

  sendPurchaseQueueChanged(owner: string): void {
    for (const context of this.windows.values()) {
      if (context.purchaseQueueOwner === owner) context.send(PURCHASE_QUEUE_IPC.changed, undefined)
    }
  }

  private queueOwner(partition: string): string {
    return `${partition}:${this.config.url?.origin ?? ''}`
  }

  fromEvent(event: IpcMainInvokeEvent): WorkWindow {
    const context = this.windows.get(event.sender.id)
    if (!context || event.senderFrame !== context.mainWindow.webContents.mainFrame || context.lifetime.signal.aborted) {
      throw new Error('拒绝来自非业务窗口的请求')
    }
    return context
  }

  fromFileDropEvent(event: Electron.IpcMainEvent): WorkWindow {
    const context = [...this.windows.values()].find(window => !window.lifetime.signal.aborted &&
      ((event.sender === window.mainWindow.webContents && event.senderFrame === event.sender.mainFrame) ||
        window.erpController.acceptsFileDrop(event)))
    if (!context) throw new Error('拒绝来自非业务窗口的文件拖入')
    return context
  }

  private assertShell(event: IpcMainInvokeEvent, managerOnly = false): void {
    const isManager = this.manager && event.sender === this.manager.webContents
    if ((!isManager && (managerOnly || !this.windows.has(event.sender.id))) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('拒绝来自非客户端界面的账号请求')
    }
  }

  private loadShell(window: BrowserWindow, manager = false): void {
    const url = process.env.ELECTRON_RENDERER_URL
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.once('ready-to-show', () => window.show())
    if (url) void window.loadURL(`${url}${manager ? '#accounts' : ''}`)
    else void window.loadFile(join(__dirname, '../renderer/index.html'), manager ? { hash: 'accounts' } : {})
  }

  private preferences() {
    return { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  }

  openManager(): void {
    if (this.manager && !this.manager.isDestroyed()) { this.manager.show(); this.manager.focus(); return }
    const window = new BrowserWindow({ title: '账号管理 · ERP 票据助手', width: 1060, height: 760,
      minWidth: 960, minHeight: 640, show: false, webPreferences: this.preferences() })
    this.manager = window
    window.on('closed', () => { this.manager = null })
    this.loadShell(window, true)
  }

  open(accountId: string | null): void {
    const existing = [...this.windows.values()].find(context => context.accountId === accountId)
    if (existing) {
      if (existing.mainWindow.isMinimized()) existing.mainWindow.restore()
      existing.mainWindow.show(); existing.mainWindow.focus(); return
    }
    const account = accountId ? this.accounts.get(accountId) : undefined
    const purchaseQueueOwner = account ? this.queueOwner(this.accounts.partition(account.id)) : null
    const bounds = accountId ? this.validBounds(this.accounts.bounds(accountId)) : undefined
    const window = new BrowserWindow({ width: 1280, height: 800, ...bounds, minWidth: 960, minHeight: 640,
      title: account ? `${account.label} (${account.username}) · ERP 票据助手` : '手动登录 · ERP 票据助手',
      show: false, webPreferences: this.preferences() })
    // Page titles must not erase the account label in the operating-system taskbar.
    window.on('page-title-updated', event => event.preventDefault())
    const workflowSessions = new WorkflowSessionManager()
    const lifetime = new AbortController()
    const send = (channel: string, value: unknown): void => {
      if (!lifetime.signal.aborted && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, value)
    }
    let previousIdentityStatus: string | undefined
    const erpController = new ErpViewController(window, this.config, state => {
      if (previousIdentityStatus === 'signed-in' && state.account?.status !== 'signed-in') workflowSessions.clear()
      previousIdentityStatus = state.account?.status
      workflowSessions.retainOpenPages(state.openPageIds)
      if (purchaseQueueOwner && this.purchaseQueue) {
        try {
          if (state.account?.status === 'signed-in') {
            this.purchaseQueue.retainPages(purchaseQueueOwner, state.openPageIds)
            this.purchaseQueue.activate(purchaseQueueOwner)
          } else {
            this.purchaseQueue.retainPages(purchaseQueueOwner, [])
            this.purchaseQueue.suspend(purchaseQueueOwner)
          }
        } catch { /* Queue errors are reported by its IPC without disrupting ERP navigation. */ }
      }
      send(ERP_IPC.stateChanged, state)
    }, account ? {
      partition: this.accounts.partition(account.id), account,
      credentials: () => this.accounts.credentials(account.id, this.config.url!.origin)
    } : {})
    this.windows.set(window.webContents.id, { mainWindow: window, erpController, workflowSessions, accountId, purchaseQueueOwner, lifetime, send })
    const senderId = window.webContents.id
    window.on('close', () => {
      if (accountId) {
        try { this.accounts.saveBounds(accountId, window.getNormalBounds()) }
        catch { /* A geometry write failure must not prevent closing a window. */ }
      }
    })
    window.on('closed', () => {
      lifetime.abort(new Error('窗口已关闭'))
      erpController.dispose()
      workflowSessions.clear()
      if (purchaseQueueOwner) {
        try { this.purchaseQueue?.retainPages(purchaseQueueOwner, []) } catch { /* Persisted results remain recoverable. */ }
      }
      this.windows.delete(senderId)
      this.broadcast()
    })
    this.loadShell(window)
    this.broadcast()
  }

  openAll(): void {
    const accounts = this.accounts.list()
    for (const account of accounts) this.open(account.id)
    if (!accounts.length) this.openManager()
  }

  private validBounds(value?: SavedBounds): SavedBounds | undefined {
    if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)) return undefined
    const display = screen.getDisplayMatching(value).workArea
    const width = Math.max(960, Math.min(value.width, display.width))
    const height = Math.max(640, Math.min(value.height, display.height))
    return { width, height, x: Math.max(display.x, Math.min(value.x, display.x + display.width - width)),
      y: Math.max(display.y, Math.min(value.y, display.y + display.height - height)) }
  }

  private tile(): void {
    const windows = [...this.windows.values()]
    if (!windows.length) return
    const focused = BrowserWindow.getFocusedWindow()
    const area = (focused ? screen.getDisplayMatching(focused.getBounds()) : screen.getPrimaryDisplay()).workArea
    const columns = Math.min(windows.length, Math.max(1, Math.floor(area.width / 960)))
    const rows = Math.ceil(windows.length / columns)
    // Keep the ERP's minimum usable size on small screens; cascade if a true grid cannot fit.
    const fits = area.width / columns >= 960 && area.height / rows >= 640
    const cascadeWidth = Math.max(960, area.width - 100)
    const cascadeHeight = Math.max(640, area.height - 100)
    const cascadeSlots = Math.max(1, Math.floor(Math.min(area.width - cascadeWidth, area.height - cascadeHeight) / 28) + 1)
    windows.forEach(({ mainWindow }, i) => {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.setBounds(fits ? { x: area.x + (i % columns) * Math.floor(area.width / columns),
        y: area.y + Math.floor(i / columns) * Math.floor(area.height / rows),
        width: Math.floor(area.width / columns), height: Math.floor(area.height / rows) } :
        { x: area.x + (i % cascadeSlots) * 28, y: area.y + (i % cascadeSlots) * 28, width: cascadeWidth, height: cascadeHeight })
      mainWindow.show()
    })
  }

  private broadcast(): void {
    if (this.manager && !this.manager.isDestroyed()) this.manager.webContents.send(ACCOUNT_IPC.changed)
  }

  registerIpc(): void {
    ipcMain.handle(ACCOUNT_IPC.manager, event => { this.assertShell(event); this.openManager() })
    ipcMain.handle(ACCOUNT_IPC.list, event => {
      this.assertShell(event, true)
      return this.accounts.list().map(account => ({ ...account, isOpen: [...this.windows.values()].some(context => context.accountId === account.id) }))
    })
    ipcMain.handle(ACCOUNT_IPC.save, async (event, input: unknown) => {
      this.assertShell(event, true)
      const id = input && typeof input === 'object' ? (input as { id?: unknown }).id : undefined
      if ([...this.windows.values()].some(context => context.accountId === id)) throw new Error('请先关闭该账号窗口，再修改账号配置')
      const previousPartition = typeof id === 'string' ? this.accounts.partition(id) : undefined
      this.accounts.save(input, this.config.url?.origin ?? '')
      if (typeof id === 'string' && previousPartition && previousPartition !== this.accounts.partition(id)) {
        this.purchaseQueue?.removeOwner(this.queueOwner(previousPartition))
        await session.fromPartition(previousPartition).clearStorageData()
      }
      this.broadcast()
    })
    ipcMain.handle(ACCOUNT_IPC.remove, async (event, id: unknown) => {
      this.assertShell(event, true)
      if (typeof id !== 'string') throw new Error('账号无效')
      this.accounts.get(id)
      if ([...this.windows.values()].some(context => context.accountId === id)) throw new Error('请先关闭该账号窗口，再删除账号')
      // Remove credentials first, preventing a concurrent open while cookies are being cleared.
      const partition = this.accounts.partition(id)
      this.accounts.remove(id)
      this.purchaseQueue?.removeOwner(this.queueOwner(partition))
      await session.fromPartition(partition).clearStorageData()
      this.broadcast()
    })
    ipcMain.handle(ACCOUNT_IPC.open, (event, id: unknown) => {
      this.assertShell(event, true)
      if (id !== null && typeof id !== 'string') throw new Error('账号无效')
      this.open(id)
    })
    ipcMain.handle(ACCOUNT_IPC.openAll, event => { this.assertShell(event, true); this.openAll() })
    ipcMain.handle(ACCOUNT_IPC.tile, event => { this.assertShell(event); this.tile() })
    ipcMain.handle(ACCOUNT_IPC.retryLogin, event => { this.fromEvent(event).erpController.retryLogin() })
  }
}
