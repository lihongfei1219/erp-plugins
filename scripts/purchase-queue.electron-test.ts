// Run after the production renderer/preload build. All ERP traffic is loopback;
// image files, account identities and OCR results are synthetic.
import assert from 'node:assert/strict'
import { app, BrowserWindow, dialog, nativeImage, type OpenDialogOptions, type WebContentsView } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AccountStore } from '../src/main/account-store'
import { WindowManager } from '../src/main/window-manager'
import { PurchaseQueueManager } from '../src/main/purchase-queue'
import { registerPurchaseQueueIpc } from '../src/main/purchase-queue-ipc'
import { registerWorkflowIpc } from '../src/main/workflow-ipc'
import { normalizeGoodsReceiptSubmission } from '../src/main/businesses/goods-receipt-tool'
import { normalizePurchaseOrderSubmission } from '../src/main/businesses/purchase-order-tool'
import type { DocumentExtractionClient } from '../src/main/document-extraction-client'
import type { OcrDocumentResult } from '../src/shared/ocr'
import type { PurchaseQueueTask } from '../src/shared/purchase-queue'

const dropping = process.argv.includes('file-drop') || process.argv.includes('file-drop-purchase')
const goods = process.argv.includes('goods-queue') || process.argv.includes('file-drop')
const businessId = goods ? 'goods-receipt' : 'purchase-order'
const reportName = dropping ? goods ? 'file-drop' : 'file-drop-purchase' : goods ? 'goods-queue' : 'purchase-queue'

mkdirSync(resolve('tmp'), { recursive: true })
const directory = mkdtempSync(resolve('tmp/purchase-queue-electron-'))
app.disableHardwareAcceleration()
app.setPath('userData', join(directory, 'profile'))
app.on('window-all-closed', () => {})
const checks: string[] = []
const deadline = setTimeout(() => finish(new Error('Purchase queue Electron regression timed out')), 75000)

function finish(error?: unknown): void {
  clearTimeout(deadline)
  const report = { passed: !error, checks, error: error instanceof Error ? error.stack : error ? String(error) : null }
  writeFileSync(resolve(`tmp/${reportName}-electron-result.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  app.exit(error ? 1 : 0)
}

async function until(predicate: () => boolean | Promise<boolean>, description: string, timeout = 10000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(`Expected state was not reached: ${description}`)
}

function resultFor(name: 'A' | 'B'): OcrDocumentResult {
  const extraction = normalizePurchaseOrderSubmission({
    header: {
      supplierName: `合成供应商 ${name}`, sourceOrderNumber: `SYNTHETIC-${name}`, invoiceDate: '2026-10-22',
      departureDate: '2026-10-22', customerName: null, receivingAddress: null, carrierName: null,
      transportMethod: null, coldChain: null, transportTimeLimit: null, receiptRemark: null,
      remark: `合成票据 ${name}`, paymentMethod: null, groupName: null
    },
    items: [{
      productName: `合成商品 ${name}`, specification: '10片', dosageForm: '片剂', manufacturer: '合成厂家',
      origin: null, approvalNumber: null, marketingAuthorizationHolder: null, unit: '盒', packageQuantity: null,
      batchNumber: 'SYNTHETIC', quantity: name === 'A' ? 2 : 3, taxIncludedUnitPrice: 5,
      taxIncludedAmount: name === 'A' ? 10 : 15, productionDate: null, expiryDate: null,
      qualityStatus: null, sourcePages: [1]
    }],
    evidence: [], reviewRequired: []
  }, 1)
  const data = goods ? normalizeGoodsReceiptSubmission({
    header: { supplierName: `合成供应商 ${name}`, departureDate: '2026-10-22', receiptRemark: '合成收货备注' },
    items: [{ productName: `合成商品 ${name}`, specification: '10片', manufacturer: '合成厂家', unit: '盒',
      arrivalQuantity: name === 'A' ? 2 : 3, receiptQuantity: name === 'A' ? 2 : 3, unitPrice: 5,
      batchNumber: 'SYNTHETIC', sourcePages: [1] }], evidence: [], reviewRequired: []
  }, 1) : extraction
  return { businessId, fileName: `${name}.png`, pageCount: 1, blockCount: 0,
    ocrPages: 1, engine: 'synthetic-offline', modelVersion: 'test', elapsedMs: 1, coveragePercent: 100,
    warnings: [], pages: [], extractedData: data }
}

const editorHtml = `<input id="Ename" value="${goods ? 'SPSHDJ' : 'CGDD'}"><input id="Cname" value="${goods ? '商品收货登记' : '采购订单'}"><input id="Mode" value="Add">
  ${['DWMC', 'DWBH', 'QYRQ', 'FKFS', 'BZ', 'CYDW', 'CYFS', 'LCSP', 'YSSX', 'SHBZ', 'FZ', 'SHDJBZ'].map(id => `<input id="${id}">`).join('')}
  <script>
    const rows = [];
    window.gridEditBody = { getRows: () => rows };
    window.gridhandler = () => {
      const cells = Object.fromEntries('SPMC SPBH GG SCCS SL DJ JE DW DHSL SHSL JSSL SPPH SCRQ YXQZ SPM JX BZ'.split(' ').map(key => [key, {
        value: '', getValue() { return this.value }, setValue(value) {
          this.value = value;
          if (key === 'SL' || key === 'DJ') cells.JE.value = Number(cells.SL.value || 0) * Number(cells.DJ.value || 0);
        }
      }]));
      rows.push({ cells: () => cells });
    };
  </script>`

async function run(): Promise<void> {
  await app.whenReady()
  // WindowManager creates real windows, but this regression must never display them.
  BrowserWindow.prototype.show = function () {}
  BrowserWindow.prototype.focus = function () {}

  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    const username = /synthetic-account=([^;]+)/.exec(request.headers.cookie ?? '')?.[1]
    if (request.url === '/Login.aspx' && request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk.toString()
      const fields = new URLSearchParams(body)
      assert.equal(fields.get('password'), 'synthetic-password')
      response.setHeader('Set-Cookie', `synthetic-account=${fields.get('user')}; Path=/; Max-Age=3600; HttpOnly`)
      response.writeHead(302, { Location: '/Default.aspx' })
      response.end()
      return
    }
    if (!username) {
      response.end('<form method="post" action="/Login.aspx"><input id="tbUser" name="user"><input id="tbPassword" name="password" type="password"><input id="btnLogin" type="submit" value="登录"></form>')
      return
    }
    if (request.url === '/purchase') { response.end(editorHtml.replace('SPSHDJ', 'CGDD').replace('商品收货登记', '采购订单')); return }
    if (request.url === '/unit') { response.end('<input id="Ename" value="DWSYSP"><input id="Cname" value="单位首营审批"><input id="Mode" value="Add"><input id="DWMC"><input id="YYZZH">'); return }
    if (request.url?.startsWith('/editor')) { response.end(editorHtml); return }
    if (request.url === '/Login.aspx') {
      response.writeHead(302, { Location: '/Default.aspx' }); response.end(); return
    }
    response.end(`<div data-erp-username="${username}">${username}</div><iframe id="a" src="/editor?a" style="width:800px;height:600px"></iframe><iframe id="b" src="/editor?b" style="display:none;width:800px;height:600px"></iframe>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const url = new URL(`http://127.0.0.1:${port}/Login.aspx`)
  const accounts = new AccountStore(join(directory, 'accounts.json'), {
    encrypt: value => `synthetic:${value}`, decrypt: value => value.slice('synthetic:'.length)
  })
  accounts.save({ label: '队列测试一', username: 'synthetic-user-a', password: 'synthetic-password' }, url.origin)
  accounts.save({ label: '队列测试二', username: 'synthetic-user-b', password: 'synthetic-password' }, url.origin)
  const windows = new WindowManager(accounts, { url, allowedOrigins: new Set([url.origin]) })

  const imagePaths = ['A', 'B'].map((name, index) => {
    const path = join(directory, `${name}.png`)
    const width = 600, height = 420
    const bitmap = Buffer.alloc(width * height * 4, 255)
    for (let y = 20; y < height - 20; y++) for (let x = 20; x < width - 20; x++) {
      const offset = (y * width + x) * 4
      const line = y > 100 && (y % 40 === 0 || x === 20 || x === 200 || x === 400 || x === width - 21)
      if (y < 70) {
        bitmap[offset] = index ? 90 : 175
        bitmap[offset + 1] = index ? 155 : 110
        bitmap[offset + 2] = index ? 175 : 35
      } else if (line) bitmap.fill(175, offset, offset + 3)
    }
    writeFileSync(path, nativeImage.createFromBitmap(bitmap, { width, height }).toPNG())
    return path
  })
  const firstImage = readFileSync(imagePaths[0])
  const recognitions: string[] = []
  let releaseSecond!: () => void
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  const extractor: DocumentExtractionClient = {
    extractDocument: async (filePath, progress, options) => {
      assert.equal(options.businessId, businessId)
      assert.deepEqual(options.excludedPages ?? [], [])
      const name = readFileSync(filePath).equals(firstImage) ? 'A' : 'B'
      recognitions.push(name)
      progress({ stage: 'recognizing', current: 0, total: 1, message: `合成识别 ${name}` })
      if (name === 'B') await secondGate
      options.signal?.throwIfAborted()
      return { status: 'completed', message: '合成结果', result: resultFor(name) }
    }
  }
  const queue = new PurchaseQueueManager(join(directory, 'queue'), extractor, owner => windows.sendPurchaseQueueChanged(owner))
  windows.attachPurchaseQueue(queue)
  registerWorkflowIpc(windows, extractor)
  registerPurchaseQueueIpc(windows, queue)
  windows.registerIpc()

  let selectionOptions: OpenDialogOptions | undefined
  const originalDialog = dialog.showOpenDialog
  dialog.showOpenDialog = (async (_window: BrowserWindow, options: OpenDialogOptions) => {
    selectionOptions = options
    return { canceled: false, filePaths: imagePaths }
  }) as typeof dialog.showOpenDialog

  windows.openAll()
  const workWindows = BrowserWindow.getAllWindows().sort((left, right) => left.getTitle().localeCompare(right.getTitle()))
  assert.equal(workWindows.length, 2)
  for (const workWindow of workWindows) workWindow.webContents.setBackgroundThrottling(false)
  const [window, otherWindow] = workWindows
  const context = windows.fromEvent({ sender: window.webContents, senderFrame: window.webContents.mainFrame } as Electron.IpcMainInvokeEvent)
  const erpView = window.contentView.children[0] as WebContentsView
  const erp = erpView.webContents
  const script = <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code)
  const list = (): Promise<PurchaseQueueTask[]> => script('window.desktop.purchaseQueue.list()')
  const selected = (): Promise<string | null> => script(`document.querySelector('[data-testid="purchase-detail"]')?.getAttribute('data-task-id') ?? null`)
  const enabled = (testId: string): Promise<boolean> => script(`Boolean(document.querySelector('[data-testid="${testId}"]:not(:disabled)'))`)
  const click = async (testId: string): Promise<void> => {
    await until(() => enabled(testId), `${testId} enabled`)
    await script(`document.querySelector('[data-testid="${testId}"]').click()`)
  }
  const dropFiles = async (target: Electron.WebContents, paths: string[], x: number, y: number): Promise<void> => {
    target.debugger.attach('1.3')
    try {
      const data = { items: [], files: paths, dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await target.debugger.sendCommand('Input.dispatchDragEvent', { type, x, y, data })
      }
    } finally { target.debugger.detach() }
  }
  const capture = async (fileName: string): Promise<void> => {
    // A hidden window may have an older compositor frame even after DOM assertions pass.
    // Temporarily make the *page capturer* active to request a fresh frame; the
    // native BrowserWindow remains hidden throughout both captures.
    assert.equal(window.isVisible(), false)
    await window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true })
    await script(`new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80)));
      setTimeout(resolve, 300);
    })`)
    await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      .then(image => writeFileSync(resolve('tmp', fileName), image.toPNG()))
    assert.equal(window.isVisible(), false)
  }

  try {
    await until(async () => (await Promise.all(workWindows.map(workWindow => workWindow.webContents.executeJavaScript('window.desktop?.erp.getState()').catch(() => null)))).every(state => state?.account?.status === 'signed-in'), 'both synthetic accounts signed in')
    await until(() => enabled('purchase-add'), 'actual purchase queue renderer mounted')
    await until(() => context.erpController.getState().openPageIds.length === 2, 'two distinct new purchase pages detected')
    const originalPage = context.erpController.getState().currentPage!.pageId!
    const legacySelection = await script<{ status: string; preview: unknown }>(`window.desktop.ocr.selectDocument(${JSON.stringify({ sessionId: 'legacy-purchase', businessId, pageId: originalPage })})`)
    assert.equal(legacySelection.status, 'failed')
    assert.equal(legacySelection.preview, null)
    assert.equal(Boolean(selectionOptions), false)
    if (dropping) {
      await script('window.dropEvents = []; window.desktop.files.onDrop(value => window.dropEvents.push(value)); void 0')
      await dropFiles(window.webContents, imagePaths, 1100, 300)
    } else await click('purchase-add')
    await until(async () => (await list()).length === 2, 'two images imported through actual IPC')
    if (dropping) assert.equal(selectionOptions, undefined, 'dropping must not open the file picker')
    else {
      assert.ok(selectionOptions?.properties?.includes('multiSelections'))
      assert.ok(selectionOptions?.properties?.includes('openFile'))
    }
    assert.equal(await script(`Boolean(document.querySelector('.preview-dialog'))`), false)
    await until(async () => (await list()).some(task => task.fileName === 'A.png' && task.recognitionStatus === 'ready'), 'first image ready without starting the old preview flow')
    const initialTasks = await list()
    const first = initialTasks.find(task => task.fileName === 'A.png')!
    const second = initialTasks.find(task => task.fileName === 'B.png')!
    assert.notEqual(second.recognitionStatus, 'ready')
    await until(async () => await selected() === first.taskId && await enabled('purchase-fill'), 'first result is selected and fillable while second is blocked')
    await click('purchase-fill')
    await until(async () => (await list()).find(task => task.taskId === first.taskId)?.usageStatus === 'filled', 'first task filled before second OCR completes')
    assert.equal(await erp.executeJavaScript(`document.getElementById('a').contentDocument.getElementById('DWMC').value`), '合成供应商 A')
    assert.equal(await erp.executeJavaScript(`document.getElementById('a').contentWindow.gridEditBody.getRows()[0].cells().${goods ? 'SHSL' : 'SL'}.getValue()`), '2')
    assert.notEqual((await list()).find(task => task.taskId === second.taskId)?.recognitionStatus, 'ready')
    checks.push('Actual dialog IPC allows multiple images, bypasses page filtering and fills A while B is still recognizing')
    if (dropping) {
      const token = await script<string>('window.dropEvents.find(value => value.kind === "ready").token')
      await assert.rejects(script(`window.desktop.purchaseQueue.addDropped('${businessId}', ${JSON.stringify(token)})`), /失效/)
      await assert.rejects(otherWindow.webContents.executeJavaScript(`window.desktop.purchaseQueue.addDropped('${businessId}', ${JSON.stringify(token)})`), /失效/)
      checks.push('Trusted OS-style sidebar drop imports both files without a picker; tokens cannot be replayed or used by another account')
    }

    const legacyFill = await script<{ status: string }>(`window.desktop.erp.fillSession(${JSON.stringify({ sessionId: `purchase-queue:${first.taskId}:${originalPage}`, businessId })})`)
    assert.equal(legacyFill.status, 'failed')
    assert.equal(await erp.executeJavaScript(`document.getElementById('a').contentWindow.gridEditBody.getRows().length`), 1)
    checks.push('Legacy purchase selectDocument and fillSession endpoints cannot bypass the queue')

    releaseSecond()
    await until(async () => (await list()).find(task => task.taskId === second.taskId)?.recognitionStatus === 'ready', 'second result completed')
    await until(() => script<boolean>(`document.querySelector('[data-testid="purchase-task"][data-task-id="${second.taskId}"]')?.getAttribute('data-recognition-status') === 'ready'`), 'renderer received second completion')
    assert.equal(await selected(), first.taskId)
    assert.equal(await erp.executeJavaScript(`document.getElementById('a').contentDocument.getElementById('DWMC').value`), '合成供应商 A')
    await capture(`${reportName}-ui.png`)
    checks.push('A remains selected and its ERP fields stay untouched when B completes in the background')

    const recognitionCount = recognitions.length
    await erp.executeJavaScript(`document.getElementById('a').contentWindow.gridEditBody.getRows().splice(0); void 0`)
    await click('purchase-fill')
    await until(async () => await erp.executeJavaScript(`document.getElementById('a').contentWindow.gridEditBody.getRows().length`) === 1 && await enabled('purchase-fill'), 'cached task refills the original page')
    assert.equal(recognitions.length, recognitionCount)
    assert.deepEqual(recognitions.slice().sort(), ['A', 'B'])
    checks.push('Refilling the same page restores its deleted detail row without any new OCR invocation')

    await click('purchase-preview')
    await until(() => script<boolean>(`(() => { const image = document.querySelector('[data-testid="purchase-preview-dialog"] img'); return Boolean(image?.complete && image.naturalWidth > 0); })()`), 'local original-image preview displayed')
    assert.equal(erpView.getVisible(), false)
    assert.equal(await script(`document.querySelectorAll('[data-testid="purchase-preview-dialog"] input[type="checkbox"]').length`), 0)
    assert.equal(await script(`Array.from(document.querySelectorAll('[data-testid="purchase-preview-dialog"] button')).some(button => /识别|排除|上传/.test(button.textContent || ''))`), false)
    await capture(`${reportName}-preview.png`)
    await click('purchase-preview-close')
    await until(() => erpView.getVisible(), 'closing original preview restores native ERP view')
    assert.equal(await selected(), first.taskId)
    assert.equal(recognitions.length, recognitionCount)
    checks.push('Original-image preview is read-only, issues no OCR request and restores the native ERP view when closed')

    await erp.executeJavaScript(`document.getElementById('a').style.display = 'none'; document.getElementById('b').style.display = 'block'`)
    await until(() => context.erpController.getState().currentPage?.pageId !== originalPage, 'new purchase page activated')
    await until(async () => await selected() === second.taskId && await enabled('purchase-fill'), 'new page automatically selects available B')
    assert.equal(await erp.executeJavaScript(`document.getElementById('b').contentDocument.getElementById('DWMC').value`), '')
    const secondPage = context.erpController.getState().currentPage!.pageId!
    await erp.executeJavaScript(`(() => {
      const editor = document.getElementById('b').contentWindow;
      editor.document.getElementById('DWMC').value = '人工供应商';
      editor.gridhandler(); editor.gridEditBody.getRows()[0].cells().SPMC.setValue('人工商品');
    })()`)
    const occupiedFill = await script<{ status: string }>(`window.desktop.purchaseQueue.fill(${JSON.stringify({ taskId: second.taskId, pageId: secondPage })})`)
    assert.equal(occupiedFill.status, 'failed')
    assert.equal(await erp.executeJavaScript(`document.getElementById('b').contentDocument.getElementById('DWMC').value`), '人工供应商')
    assert.equal(await erp.executeJavaScript(`document.getElementById('b').contentWindow.gridEditBody.getRows()[0].cells().SPMC.getValue()`), '人工商品')
    assert.equal((await list()).find(task => task.taskId === second.taskId)?.usageStatus, 'available')
    assert.equal((await list()).find(task => task.taskId === second.taskId)?.boundPageId, null)
    checks.push('Actual queue IPC refuses an existing manual supplier/product order without changing its fields or consuming the task')
    await erp.executeJavaScript(`document.getElementById('b').contentDocument.getElementById('DWMC').value = ''; document.getElementById('b').contentWindow.gridEditBody.getRows().splice(0); void 0`)
    await click('purchase-fill')
    await until(async () => (await list()).find(task => task.taskId === second.taskId)?.usageStatus === 'filled', 'B fills from local result')
    assert.equal(await erp.executeJavaScript(`document.getElementById('b').contentDocument.getElementById('DWMC').value`), '合成供应商 B')
    assert.equal(recognitions.length, recognitionCount)
    checks.push('Opening a different new purchase page recommends B and fills its cached result without OCR')

    if (goods) {
      // A cached purchase result must never appear in or be consumed by a receipt page.
      const purchaseResult = resultFor('A')
      purchaseResult.businessId = 'purchase-order'
      purchaseResult.extractedData = normalizePurchaseOrderSubmission({
        header: { supplierName: '合成采购供应商' },
        items: [{ productName: '合成采购商品', quantity: 1, taxIncludedUnitPrice: 5, sourcePages: [1] }], evidence: [], reviewRequired: []
      }, 1)
      const originalExtract = extractor.extractDocument
      extractor.extractDocument = async () => ({ status: 'completed', message: '', result: purchaseResult })
      const purchase = (await queue.enqueue(context.purchaseQueueOwner!, [imagePaths[0]], 'purchase-order')).added[0]
      await until(() => queue.get(context.purchaseQueueOwner!, purchase).recognitionStatus === 'ready', 'mixed purchase task ready')
      assert.equal(queue.get(context.purchaseQueueOwner!, purchase).readyForAutofill, true)
      extractor.extractDocument = originalExtract
      await until(async () => (await list()).length === 3, 'mixed snapshot received')
      assert.equal(await script(`document.querySelectorAll('[data-testid="purchase-task"]').length`), 2)
      const wrongBusiness = await script<{ status: string; message: string }>(`window.desktop.purchaseQueue.fill(${JSON.stringify({ taskId: purchase, pageId: secondPage })})`)
      assert.equal(wrongBusiness.status, 'failed')
      assert.match(wrongBusiness.message, /业务不一致/)
      assert.equal(queue.get(context.purchaseQueueOwner!, purchase).usageStatus, 'available')
      assert.equal(queue.get(context.purchaseQueueOwner!, purchase).boundPageId, null)
      const beforeSwitch = await selected()
      await erp.executeJavaScript(`(() => {
        const frame = document.createElement('iframe'); frame.id = 'purchase'; frame.src = '/purchase';
        frame.style = 'width:800px;height:600px'; document.getElementById('b').style.display = 'none'; document.body.appendChild(frame);
      })()`)
      await until(() => context.erpController.getState().currentPage?.businessId === 'purchase-order', 'purchase editor active')
      await until(async () => await selected() === purchase, 'purchase page recommends only purchase task')
      assert.equal(await script(`document.querySelectorAll('[data-testid="purchase-task"]').length`), 1)
      await erp.executeJavaScript(`document.getElementById('purchase').remove(); document.getElementById('b').style.display = 'block'`)
      await until(async () => await selected() === beforeSwitch, 'receipt selection restored after business switch')
      queue.remove(context.purchaseQueueOwner!, purchase)
      checks.push('Mixed purchase and receipt queues filter by business; forged cross-business fill cannot claim or alter a task; switching restores the receipt selection')
    }


    assert.deepEqual(await otherWindow.webContents.executeJavaScript('window.desktop.purchaseQueue.list()'), [])
    await assert.rejects(otherWindow.webContents.executeJavaScript(`window.desktop.purchaseQueue.get(${JSON.stringify(first.taskId)})`))
    const otherState = await otherWindow.webContents.executeJavaScript('window.desktop.erp.getState()')
    const forgedFill = await otherWindow.webContents.executeJavaScript(`window.desktop.purchaseQueue.fill(${JSON.stringify({ taskId: first.taskId, pageId: otherState.currentPage.pageId })})`).catch(() => ({ status: 'failed' }))
    assert.notEqual(forgedFill.status, 'filled')
    checks.push('Real sender-based account scopes reject cross-account task reads and forged autofill')

    await click('purchase-preview')
    await until(() => script<boolean>(`Boolean(document.querySelector('[data-testid="purchase-preview-dialog"]'))`), 'preview reopened before renderer crash')
    assert.equal(erpView.getVisible(), false)
    const rendererGone = new Promise<void>(resolve => window.webContents.once('render-process-gone', () => resolve()))
    window.webContents.forcefullyCrashRenderer()
    await rendererGone
    await until(() => erpView.getVisible(), 'main process restores ERP view after renderer crash')
    window.webContents.reload()
    await until(() => script<boolean>(`Boolean(window.desktop?.purchaseQueue && document.querySelector('[data-testid="purchase-queue"]'))`).catch(() => false), 'renderer reload restores purchase queue')
    const recoveredTasks = await list()
    assert.equal(recoveredTasks.length, 2)
    assert.ok(recoveredTasks.every(task => task.recognitionStatus === 'ready' && task.usageStatus === 'filled'))
    assert.equal(recognitions.length, recognitionCount)
    checks.push('Crashing the renderer while preview is open restores the ERP view; reloading recovers both cached tasks without OCR')
    if (dropping) {
      const countBeforeDrop = recognitions.length
      const invalidPath = join(directory, 'unsupported.txt')
      writeFileSync(invalidPath, 'synthetic unsupported file')
      assert.equal(await erp.executeJavaScript('typeof window.desktop'), 'undefined')
      await dropFiles(erp, [imagePaths[0], invalidPath, directory], 150, 150)
      await until(async () => (await list()).length === 3, 'native ERP iframe drop imports the valid image')
      await until(() => script<boolean>(`document.querySelector('.purchase-import-errors')?.textContent.includes('unsupported.txt') ?? false`), 'unsupported files reported individually')
      assert.equal(recognitions.length, countBeforeDrop + 1)
      assert.equal((await list()).filter(task => task.usageStatus === 'filled').length, 2)
      assert.equal(erp.getURL(), `${url.origin}/Default.aspx`)
      assert.equal(selectionOptions, undefined)
      checks.push('Drop directly onto native ERP iframe reuses queue validation, imports valid files, reports invalid files/directories and never navigates or auto-fills')

      // Hold a real drop notification to test authorization before its token is consumed.
      const originalSend = context.send
      let heldToken: string | undefined
      context.send = (channel, value) => {
        if (channel === 'files:feedback' && (value as { kind?: string })?.kind === 'ready') {
          heldToken = (value as { token: string }).token
        } else originalSend(channel, value)
      }
      await dropFiles(erp, [imagePaths[0]], 150, 150)
      await until(() => Boolean(heldToken), 'drop token held before renderer consumption')
      context.send = originalSend
      await assert.rejects(otherWindow.webContents.executeJavaScript(`window.desktop.purchaseQueue.addDropped('${businessId}', ${JSON.stringify(heldToken)})`), /失效/)

      await erp.executeJavaScript(`document.getElementById('b').contentDocument.getElementById('Mode').value = 'Edit'`)
      await until(() => context.erpController.getState().currentPage?.isNew === false, 'non-new form detected')
      await assert.rejects(script(`window.desktop.purchaseQueue.addDropped('${businessId}', ${JSON.stringify(heldToken)})`), /切换/)
      await dropFiles(erp, [imagePaths[0]], 150, 150)
      await until(() => script<boolean>(`document.querySelector('[data-testid="file-drop-error"]')?.textContent.includes('新建') ?? false`), 'wrong-page drop rejected')
      assert.equal((await list()).length, 3)
      checks.push('An unconsumed drop token remains private to its account and is rejected if the target form changes before import')

      await erp.executeJavaScript(`document.getElementById('b').src = '/unit'`)
      await until(() => context.erpController.getState().currentPage?.businessId === 'unit-initial-approval', 'unit editor active')
      await dropFiles(erp, imagePaths, 150, 150)
      await until(() => script<boolean>(`document.querySelector('[data-testid="file-drop-error"]')?.textContent.includes('每次请拖入一个') ?? false`), 'unit multi-file drop rejected without truncation')
      await dropFiles(erp, [imagePaths[0]], 150, 150)
      await until(() => script<boolean>(`Boolean(document.querySelector('.preview-dialog input[type="checkbox"]'))`), 'unit drop opens the original page filter')
      assert.equal(erpView.getVisible(), false)
      assert.equal(recognitions.length, countBeforeDrop + 1, 'unit drop must not automatically call OCR')
      assert.equal(selectionOptions, undefined)
      await script(`document.querySelector('button[aria-label="关闭页面筛选"]').click()`)
      await until(() => erpView.getVisible(), 'closing unit filter restores ERP')
      checks.push('Non-new forms reject drops; unit approval accepts one file into its original privacy filter and never auto-recognizes')
    }
  } finally {
    releaseSecond()
    dialog.showOpenDialog = originalDialog
    queue.shutdown()
    for (const workWindow of workWindows) if (!workWindow.isDestroyed()) workWindow.destroy()
    server.close()
  }
}

void run().then(() => finish(), finish)
