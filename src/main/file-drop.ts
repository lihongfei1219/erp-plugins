import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { BusinessId } from '../shared/business'
import { FILE_DROP_IPC, type FileDropFeedback } from '../shared/file-drop'
import type { WindowManager, WorkWindow } from './window-manager'

interface PendingDrop {
  token: string; paths: string[]; businessId: BusinessId; pageId: string; expires: number
}
const pending = new WeakMap<WorkWindow, PendingDrop>()

export function takeDroppedFiles(context: WorkWindow, token: unknown, businessId: BusinessId): string[] {
  const drop = pending.get(context)
  if (!drop || typeof token !== 'string' || drop.token !== token || drop.expires < Date.now()) {
    throw new Error('拖入文件已失效，请重新拖入')
  }
  pending.delete(context)
  context.lifetime.signal.throwIfAborted()
  context.erpController.assertAccountReady()
  const page = context.erpController.getState().currentPage
  if (drop.businessId !== businessId || page?.businessId !== businessId || page.pageId !== drop.pageId || !page.isNew || !page.supported) {
    throw new Error('拖入后业务页面已切换，请在目标页面重新拖入')
  }
  return drop.paths
}

export function registerFileDropIpc(windows: WindowManager): void {
  ipcMain.on(FILE_DROP_IPC.dropped, (event, value: unknown) => {
    let context: WorkWindow
    try { context = windows.fromFileDropEvent(event) } catch { return }
    const send = (value: FileDropFeedback): void => context.send(FILE_DROP_IPC.feedback, value)
    const original = context.erpController.getState().currentPage
    void (async () => {
      try {
        if (!Array.isArray(value) || !value.length || value.length > 500 ||
          !value.every(path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'))) {
          throw new Error('请从本机文件夹拖入图片或 PDF，每次最多 500 个文件')
        }
        await context.erpController.refreshPageContext()
        context.lifetime.signal.throwIfAborted()
        context.erpController.assertAccountReady()
        const page = context.erpController.getState().currentPage
        if (!page?.businessId || !page.pageId || !page.isNew || !page.supported) throw new Error('请先进入需要导入的业务新建页面，再拖入票据')
        if (original?.pageId !== page.pageId || original.businessId !== page.businessId) throw new Error('业务页面正在切换，请稍后重新拖入')
        if (page.businessId !== 'unit-initial-approval' && !context.accountId) throw new Error('请从账号管理打开已保存的账号后使用批量识别')
        const paths = [...new Set(value as string[])]
        if (page.businessId === 'unit-initial-approval' && paths.length !== 1) throw new Error('单位首营每次请拖入一个图片或 PDF，随后按原流程筛选页面')
        const token = randomUUID()
        pending.set(context, { token, paths, businessId: page.businessId, pageId: page.pageId, expires: Date.now() + 120000 })
        send({ kind: 'ready', token, businessId: page.businessId, pageId: page.pageId, count: paths.length })
      } catch (error) {
        send({ kind: 'error', message: error instanceof Error ? error.message : '拖入文件失败，请重试' })
      }
    })()
  })
}
