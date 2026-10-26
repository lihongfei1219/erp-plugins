import assert from 'node:assert/strict'
import { app, BrowserWindow, dialog, safeStorage, type WebContentsView } from 'electron'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { AccountStore } from '../src/main/account-store'
import { WindowManager } from '../src/main/window-manager'
import { registerWorkflowIpc } from '../src/main/workflow-ipc'
import { PurchaseQueueManager } from '../src/main/purchase-queue'
import { registerPurchaseQueueIpc } from '../src/main/purchase-queue-ipc'
import type { DocumentExtractionClient } from '../src/main/document-extraction-client'
import type { BusinessExtraction } from '../src/shared/business'

mkdirSync(resolve('tmp'), { recursive: true })
const directory = mkdtempSync(resolve('tmp/multi-account-'))
app.setPath('userData', join(directory, 'profile'))
app.on('window-all-closed', () => {})
const checks: string[] = []
const deadline = setTimeout(() => finish(Error('Multi-account regression timed out')), 90000)
function finish(error?: unknown): void {
  clearTimeout(deadline)
  const report = { passed: !error, checks, error: error instanceof Error ? error.stack : error ? String(error) : null }
  writeFileSync(resolve('tmp/multi-account-result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  app.exit(error ? 1 : 0)
}
async function until(predicate: () => boolean | Promise<boolean>, timeout = 10000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 80)) }
  throw Error('Expected state not reached')
}
const loginPage = (error = '') => `<form method="post" action="/Login.aspx"><input id="tbUser" name="user"><input id="tbPassword" name="password" type="password"><input id="btnLogin" type="submit" value="登录"><span id="vcdc">${error}</span></form>`
const posts = new Map<string, number>()
const accountCount = 6
let cancelObserved = false

async function run(): Promise<void> {
  await app.whenReady()
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.focus = function () {}
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    const user = /account=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
    if (request.url === '/Login.aspx' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk.toString()
      const data = new URLSearchParams(body), name = data.get('user')!
      posts.set(name, (posts.get(name) ?? 0) + 1)
      if (data.get('password') !== 'synthetic-pass') { response.end(loginPage('账号或密码错误')); return }
      response.setHeader('Set-Cookie', `account=${name}; Path=/; Max-Age=3600; HttpOnly`)
      response.writeHead(302, { Location: '/Default.aspx' }); response.end(); return
    }
    if (request.url === '/Logout.aspx' || request.url === '/expire') {
      response.setHeader('Set-Cookie', 'account=; Path=/; Max-Age=0')
      response.writeHead(302, { Location: '/Login.aspx' }); response.end(); return
    }
    if (!user) { response.end(loginPage()); return }
    if (request.url === '/Login.aspx') { response.writeHead(302, { Location: '/Default.aspx' }); response.end(); return }
    response.end(`<div data-erp-username="${user}">${user}</div><a href="/Logout.aspx">退出登录</a><input id="Ename" value="DWSYSP"><input id="Cname" value="单位首营审批"><input id="Mode" value="Add"><input id="DWMC">`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const url = new URL(`http://127.0.0.1:${address.port}/Login.aspx`)
  const file = join(directory, 'accounts.json')
  const store = new AccountStore(file, { encrypt: value => safeStorage.encryptString(value).toString('base64'), decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')) })
  const manager = new WindowManager(store, { url, allowedOrigins: new Set([url.origin]) })
  manager.registerIpc()
  const extractionClient: DocumentExtractionClient = { extractDocument: async (_path, progress, options) => {
    progress({ stage: 'recognizing', current: 0, total: 1, message: 'synthetic-progress' })
    await new Promise<void>(resolve => {
      if (options.signal?.aborted) { cancelObserved = true; resolve(); return }
      options.signal?.addEventListener('abort', () => { cancelObserved = true; resolve() }, { once: true })
    })
    return { status: 'cancelled', message: 'cancelled', result: null }
  } }
  registerWorkflowIpc(manager, extractionClient)
  const purchaseQueue = new PurchaseQueueManager(join(directory, 'purchase-queue'), extractionClient,
    owner => manager.sendPurchaseQueueChanged(owner))
  manager.attachPurchaseQueue(purchaseQueue)
  registerPurchaseQueueIpc(manager, purchaseQueue)
  app.on('before-quit', () => purchaseQueue.shutdown())
  manager.openAll()
  const settings = BrowserWindow.getAllWindows()[0]
  const work = () => BrowserWindow.getAllWindows().filter(window => window !== settings)
  assert.equal(work().length, 0)
  await until(async () => settings.webContents.getURL().includes('#accounts') && await settings.webContents.executeJavaScript('!!window.desktop && !!document.querySelector(".account-editor")'))
  await settings.webContents.executeJavaScript(`(() => {
    const fields = document.querySelectorAll('.account-editor input:not([type=checkbox])');
    ['账号 1', 'user1', 'synthetic-pass'].forEach((value, index) => {
      fields[index].value = value; fields[index].dispatchEvent(new Event('input', { bubbles: true }));
    });
    document.querySelector('.account-editor').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`)
  await until(() => store.list().length === 1)
  await until(async () => await settings.webContents.executeJavaScript('document.querySelector(".account-editor input[type=password]").value === ""'))
  await settings.webContents.executeJavaScript('window.desktop.accounts.openAll()')
  await until(async () => work().length === 1 && (await work()[0].webContents.executeJavaScript('window.desktop?.erp.getState()').catch(() => null))?.account?.status === 'signed-in')
  checks.push('Startup with no saved accounts opens management; one saved account opens one work window')
  for (let i = 2; i <= accountCount; i++) {
    await settings.webContents.executeJavaScript(`window.desktop.accounts.save(${JSON.stringify({ label: `账号 ${i}`, username: `user${i}`, password: 'synthetic-pass' })})`)
  }
  assert.ok(!readFileSync(file, 'utf8').includes('synthetic-pass'))
  const profiles = await settings.webContents.executeJavaScript('window.desktop.accounts.list()')
  assert.ok(profiles.every((profile: object) => !('password' in profile) && !('secret' in profile)))
  checks.push('Real account IPC persists DPAPI ciphertext and lists only public metadata')
  await settings.webContents.executeJavaScript('window.desktop.accounts.openAll()')
  await until(async () => work().length === accountCount && (await Promise.all(work().map(window => window.webContents.executeJavaScript('window.desktop?.erp.getState()').catch(() => null)))).every(state => state?.account?.status === 'signed-in'))
  const windows = work().sort((a, b) => a.getTitle().localeCompare(b.getTitle()))
  const erp = (window: BrowserWindow) => (window.contentView.children[0] as WebContentsView).webContents
  for (let i = 0; i < windows.length; i++) {
    const actual = await erp(windows[i]).executeJavaScript('document.querySelector("[data-erp-username]").getAttribute("data-erp-username")')
    assert.equal(actual, `user${i + 1}`)
    assert.ok(windows[i].getTitle().includes(actual))
  }
  assert.equal(new Set(windows.map(window => erp(window).session)).size, accountCount)
  await settings.webContents.executeJavaScript('window.desktop.accounts.openAll()')
  assert.equal(work().length, accountCount)
  await settings.webContents.executeJavaScript('window.desktop.accounts.tile()')
  checks.push('Six saved accounts open six independent identities and can be arranged; repeated open reuses windows')

  windows[0].setSize(960, 640)
  await windows[0].webContents.capturePage().then(image => writeFileSync(resolve('tmp/account-workspace-preview.png'), image.toPNG()))

  await assert.rejects(windows[0].webContents.executeJavaScript('window.desktop.accounts.list()'))
  await assert.rejects(settings.webContents.executeJavaScript('window.desktop.erp.getState()'))
  await assert.rejects(settings.webContents.executeJavaScript(`window.desktop.accounts.save(${JSON.stringify({ ...profiles[0], label: 'changed' })})`))
  const context = (window: BrowserWindow) => manager.fromEvent({ sender: window.webContents, senderFrame: window.webContents.mainFrame } as Electron.IpcMainInvokeEvent)
  await until(() => !!context(windows[0]).erpController.getState().currentPage?.pageId)
  const first = context(windows[0]), second = context(windows[1])
  const pageId = first.erpController.getState().currentPage!.pageId!
  first.workflowSessions.bindToPage('window-one-only', 'unit-initial-approval', pageId)
  first.workflowSessions.complete('window-one-only', 'unit-initial-approval', { documentType: 'unit-initial-approval' } as BusinessExtraction)
  const forged = await windows[1].webContents.executeJavaScript(`window.desktop.erp.fillSession({ sessionId: 'window-one-only', businessId: 'unit-initial-approval' })`)
  assert.equal(forged.status, 'failed')
  assert.throws(() => second.workflowSessions.getExtraction('window-one-only', 'unit-initial-approval'))
  checks.push('Sender-based IPC rejects cross-window extraction and unauthorized account/ERP endpoints')

  await erp(windows[2]).executeJavaScript('document.querySelector("[data-erp-username]").setAttribute("data-erp-username", "another-user")')
  await until(async () => (await windows[2].webContents.executeJavaScript('window.desktop.erp.getState()')).account.status === 'mismatch')
  const blocked = await windows[2].webContents.executeJavaScript('window.desktop.erp.fillFixture({businessId:"unit-initial-approval"})')
  assert.equal(blocked.status, 'wrong-page')
  await erp(windows[2]).executeJavaScript('document.querySelector("[data-erp-username]").setAttribute("data-erp-username", "user3")')
  await until(async () => (await windows[2].webContents.executeJavaScript('window.desktop.erp.getState()')).account.status === 'signed-in')
  checks.push('Detected account mismatch blocks autofill until the expected identity is restored')

  const originalDialog = dialog.showMessageBoxSync
  dialog.showMessageBoxSync = () => 0
  await erp(windows[0]).executeJavaScript(`window.testBeforeUnload = event => { event.preventDefault(); event.returnValue = 'unsaved'; }; window.addEventListener('beforeunload', window.testBeforeUnload); document.querySelector('a').click()`, true)
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal((await windows[0].webContents.executeJavaScript('window.desktop.erp.getState()')).account.status, 'signed-in')
  assert.equal(first.workflowSessions.getExtraction('window-one-only', 'unit-initial-approval').documentType, 'unit-initial-approval')
  await erp(windows[0]).executeJavaScript('window.removeEventListener("beforeunload", window.testBeforeUnload)')
  dialog.showMessageBoxSync = originalDialog
  checks.push('Cancelling the ERP leave prompt preserves both login and the original recognition cache')

  await erp(windows[0]).executeJavaScript('document.querySelector("a").click()')
  await until(async () => (await windows[0].webContents.executeJavaScript('window.desktop.erp.getState()')).account.status === 'paused')
  await new Promise(resolve => setTimeout(resolve, 1400))
  assert.equal(posts.get('user1'), 1)
  assert.equal((await windows[1].webContents.executeJavaScript('window.desktop.erp.getState()')).account.status, 'signed-in')
  await windows[0].webContents.executeJavaScript('window.desktop.accounts.retryLogin()')
  await until(async () => (await windows[0].webContents.executeJavaScript('window.desktop.erp.getState()')).account.status === 'signed-in')
  assert.equal(posts.get('user1'), 2)
  checks.push('Explicit logout pauses only its account; explicit retry logs it back in')

  // The UI is captured without opening visible test windows.
  await settings.webContents.capturePage().then(image => writeFileSync(resolve('tmp/account-manager-preview.png'), image.toPNG()))
  await erp(windows[1]).loadURL(`${url.origin}/expire`)
  await until(() => (posts.get('user2') ?? 0) === 2)
  await until(async () => (await windows[1].webContents.executeJavaScript('window.desktop.erp.getState()')).account.status === 'signed-in')
  checks.push('Expired session automatically signs in again without disturbing other accounts')

  // A pending request must receive only its own progress and stop when its window closes.
  await first.erpController.refreshPageContext()
  const currentPage = first.erpController.getState().currentPage!.pageId!
  first.workflowSessions.bindToPage('cancel-on-close', 'unit-initial-approval', currentPage)
  first.workflowSessions.setPending({ sessionId: 'cancel-on-close', businessId: 'unit-initial-approval', token: 'local-test-token', filePath: 'synthetic', pageCount: 1 })
  await windows[1].webContents.executeJavaScript('window.testProgress = []; window.desktop.ocr.onProgress(p => window.testProgress.push(p))')
  void windows[0].webContents.executeJavaScript(`window.desktop.ocr.extractDocument({sessionId:'cancel-on-close',businessId:'unit-initial-approval',token:'local-test-token',excludedPages:[]})`).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await windows[1].webContents.executeJavaScript('window.testProgress.length'), 0)
  windows[0].close()
  await until(() => cancelObserved && work().length === accountCount - 1)
  assert.throws(() => first.workflowSessions.getPageId('cancel-on-close', 'unit-initial-approval'))
  checks.push('Closing one window cancels its extraction; progress and cleanup never reach another window')

  const before = posts.get('user1')
  await settings.webContents.executeJavaScript(`window.desktop.accounts.open(${JSON.stringify(profiles[0].id)})`)
  await until(async () => (await Promise.all(work().map(window => window.webContents.executeJavaScript('window.desktop.erp.getState()').catch(() => null)))).filter(state => state?.account?.status === 'signed-in').length === accountCount)
  assert.equal(posts.get('user1'), before)
  checks.push('Reopened account reuses its own persisted login without resubmitting credentials')

  for (const window of work()) window.close()
  await until(() => work().length === 0)
  const { session } = await import('electron')
  const previousPartition = store.partition(profiles[3].id)
  assert.ok((await session.fromPartition(previousPartition).cookies.get({})).length > 0)
  await settings.webContents.executeJavaScript(`window.desktop.accounts.save(${JSON.stringify({ ...profiles[3], username: 'renamed-user', password: 'synthetic-pass' })})`)
  assert.notEqual(store.partition(profiles[3].id), previousPartition)
  assert.equal((await session.fromPartition(previousPartition).cookies.get({})).length, 0)
  checks.push('Changing an account identity clears its former cookies and allocates a separate partition')
  await settings.webContents.executeJavaScript(`window.desktop.accounts.save(${JSON.stringify({ ...profiles[0], password: 'wrong-password' })})`)
  // Clear this account's session so a saved login cannot hide an invalid password.
  await session.fromPartition(store.partition(profiles[0].id)).clearStorageData()
  await settings.webContents.executeJavaScript(`window.desktop.accounts.open(${JSON.stringify(profiles[0].id)})`)
  await until(async () => (await work()[0].webContents.executeJavaScript('window.desktop.erp.getState()').catch(() => null))?.account?.status === 'failed')
  const failedPosts = posts.get('user1')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(posts.get('user1'), failedPosts)
  checks.push('Wrong password produces one failed attempt and never loops')
  work()[0].close()
  await until(() => work().length === 0)
  await settings.webContents.executeJavaScript(`window.desktop.accounts.remove(${JSON.stringify(profiles[0].id)})`)
  assert.equal(store.list().length, accountCount - 1)
  await settings.webContents.executeJavaScript('window.desktop.accounts.openAll()')
  await until(async () => work().length === accountCount - 1 && (await Promise.all(work().map(window => window.webContents.executeJavaScript('window.desktop?.erp.getState()').catch(() => null)))).every(state => state?.account?.status === 'signed-in'))
  checks.push('Removing a saved account reduces the next open-all operation to five windows')
  for (const window of work()) window.close()
  await until(() => work().length === 0)
  settings.destroy()
  server.close()
}
void run().then(() => finish(), finish)
