import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PurchaseQueueManager } from '../src/main/purchase-queue'
import type { DocumentExtractionClient } from '../src/main/document-extraction-client'
import type { DocumentExtractionOptions, OcrClientResult, OcrDocumentResult, OcrProgress } from '../src/shared/ocr'
import type { ErpAutofillResult } from '../src/shared/erp'

const OWNER = 'https://synthetic.erp.test|synthetic-purchaser|purchase-order'
const OTHER = 'https://synthetic.erp.test|other-purchaser|purchase-order'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYdoAAAAASUVORK5CYII=', 'base64')

function document(fileName = 'synthetic.png', readyForAutofill = true): OcrDocumentResult {
  return {
    businessId: 'purchase-order', fileName, pageCount: 1, blockCount: 0, ocrPages: 1,
    engine: 'offline-test', modelVersion: 'offline', elapsedMs: 1, coveragePercent: 100,
    warnings: [], pages: [{ pageNumber: 1, source: 'pi-ocr', text: '合成测试票据', blocks: [] }],
    extractedData: {
      documentType: 'purchase-order', header: {
        supplierName: '合成供应商', sourceOrderNumber: 'SYNTHETIC-001', invoiceDate: null,
        departureDate: null, customerName: null, receivingAddress: null, carrierName: null,
        transportMethod: null, coldChain: null, transportTimeLimit: null, receiptRemark: null,
        remark: null, paymentMethod: null, groupName: null
      }, items: [{
        productName: '合成商品', specification: null, dosageForm: null, manufacturer: null,
        origin: null, approvalNumber: null, marketingAuthorizationHolder: null, unit: null,
        packageQuantity: null, quantity: 2, taxIncludedUnitPrice: 3, taxIncludedAmount: 6,
        batchNumber: null, productionDate: null, expiryDate: null, qualityStatus: null, sourcePages: [1]
      }], fieldEvidence: {}, recognizedFieldCount: 3, missingRecommendedFields: [], reviewRequired: [], readyForAutofill
    }
  }
}

const filled: ErpAutofillResult = {
  status: 'filled', message: '合成代填完成', filledHeaderFields: 1, filledDetailRows: 1, skippedFields: []
}
const partial: ErpAutofillResult = { ...filled, status: 'partial', message: '仍有字段待填写', filledDetailRows: 0 }

class FakeClient implements DocumentExtractionClient {
  onCall?: () => void
  readonly calls: {
    path: string
    options: DocumentExtractionOptions
    progress: (progress: Omit<OcrProgress, 'sessionId' | 'businessId'>) => void
    resolve: (result: OcrClientResult) => void
  }[] = []

  extractDocument(path: string, progress: (value: Omit<OcrProgress, 'sessionId' | 'businessId'>) => void,
    options: DocumentExtractionOptions): Promise<OcrClientResult> {
    return new Promise(resolve => { this.calls.push({ path, options, progress, resolve }); this.onCall?.() })
  }

  complete(index: number, result = document()): void {
    assert.ok(this.calls[index], `missing extraction call ${index}`)
    this.calls[index].resolve({ status: 'completed', message: '完成', result })
  }
}

async function eventually(condition: () => boolean): Promise<void> {
  const timeout = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > timeout) throw new Error('Timed out waiting for queue state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function fixture(t: TestContext, options: { concurrency?: number; maxUploadBytes?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'erp-purchase-queue-test-'))
  const root = join(directory, 'cache')
  const client = new FakeClient()
  const notifications: string[] = []
  const manager = new PurchaseQueueManager(root, client, owner => notifications.push(owner), options)
  t.after(() => { manager.shutdown(); rmSync(directory, { recursive: true, force: true }) })
  function source(name: string): string {
    const path = join(directory, name)
    writeFileSync(path, PNG)
    return path
  }
  function recordPath(owner: string, taskId: string): string {
    return join(root, createHash('sha256').update(owner).digest('hex'), taskId, 'task.json')
  }
  return { directory, root, manager, client, notifications, source, recordPath }
}

test('first completed image can fill while another recognizes; next page reuses the cached result', async t => {
  const { manager, client, source, recordPath } = fixture(t)
  const imported = await manager.enqueue(OWNER, [source('first.png'), source('second.png')])
  assert.equal(imported.errors.length, 0)
  assert.equal(imported.added.length, 2)
  assert.equal(client.calls.length, 2)
  assert.equal(client.calls[0].options.businessId, 'purchase-order')
  assert.deepEqual(client.calls[0].options.excludedPages, [])
  client.complete(0)
  await eventually(() => manager.get(OWNER, imported.added[0]).recognitionStatus === 'ready')
  assert.equal(manager.get(OWNER, imported.added[1]).recognitionStatus, 'recognizing')
  assert.equal(JSON.parse(readFileSync(recordPath(OWNER, imported.added[0]), 'utf8')).task.result.businessId, 'purchase-order')
  assert.equal(manager.get(OWNER, imported.added[0]).result?.fileName, 'first.png')
  manager.beginFill(OWNER, imported.added[0], 'page-1')
  manager.finishFill(OWNER, imported.added[0], filled)
  manager.retainPages(OWNER, [])
  assert.equal(manager.get(OWNER, imported.added[0]).usageStatus, 'filled')
  client.complete(1)
  await eventually(() => manager.get(OWNER, imported.added[1]).recognitionStatus === 'ready')
  manager.beginFill(OWNER, imported.added[1], 'page-2')
  manager.finishFill(OWNER, imported.added[1], filled)
  assert.equal(client.calls.length, 2)
  assert.equal(manager.get(OWNER, imported.added[0]).boundPageId, null)
})

test('each copied file starts independently before the full import completes', async t => {
  const { manager, client, source } = fixture(t, { concurrency: 1 })
  const paths = Array.from({ length: 8 }, (_, i) => source(`image-${i}.png`))
  let importCompleted = false
  let firstCallTaskCount = 0
  let importCompletedAtFirstCall = true
  client.onCall = () => {
    if (client.calls.length !== 1) return
    firstCallTaskCount = manager.list(OWNER).length
    importCompletedAtFirstCall = importCompleted
  }
  const importing = manager.enqueue(OWNER, paths).then(result => { importCompleted = true; return result })
  await eventually(() => client.calls.length === 1)
  assert.equal(firstCallTaskCount, 1)
  assert.equal(importCompletedAtFirstCall, false)
  const firstTask = manager.list(OWNER)[0]
  assert.ok(firstTask)
  assert.equal(firstTask.recognitionStatus, 'recognizing')
  client.complete(0)
  const imported = await importing
  assert.equal(importCompleted, true)
  assert.equal(imported.added.length, 8)
  await eventually(() => manager.get(OWNER, firstTask.taskId).recognitionStatus === 'ready')
})

test('one extraction failure or invalid result cannot block other images', async t => {
  const { manager, client, source } = fixture(t)
  const { added } = await manager.enqueue(OWNER, [source('bad.png'), source('good.png'), source('wrong-business.png')])
  client.calls[0].resolve({ status: 'failed', message: '合成失败', result: null })
  client.complete(1)
  await eventually(() => client.calls.length === 3)
  client.complete(2, { ...document(), businessId: 'goods-receipt' })
  await eventually(() => manager.get(OWNER, added[2]).recognitionStatus === 'failed')
  assert.equal(manager.get(OWNER, added[0]).recognitionStatus, 'failed')
  assert.equal(manager.get(OWNER, added[1]).recognitionStatus, 'ready')
  assert.equal(manager.get(OWNER, added[2]).result, null)
  manager.retry(OWNER, added[0])
  assert.equal(client.calls.length, 4)
  client.complete(3)
  await eventually(() => manager.get(OWNER, added[0]).recognitionStatus === 'ready')
})

test('cache survives original deletion and restart; interrupted fill remains uncertain', async t => {
  const { manager, client, source, root, recordPath } = fixture(t)
  const original = source('source-file.png')
  const { added } = await manager.enqueue(OWNER, [original])
  client.complete(0)
  await eventually(() => manager.get(OWNER, added[0]).recognitionStatus === 'ready')
  manager.beginFill(OWNER, added[0], 'old-page')
  const persisted = readFileSync(recordPath(OWNER, added[0]), 'utf8')
  manager.shutdown()
  // Emulate a process crash with its last durable state still marked as filling.
  writeFileSync(recordPath(OWNER, added[0]), persisted)
  rmSync(original)
  const restartedClient = new FakeClient()
  const restarted = new PurchaseQueueManager(root, restartedClient, () => {})
  t.after(() => restarted.shutdown())
  assert.equal(restarted.get(OWNER, added[0]).usageStatus, 'uncertain')
  assert.equal(restarted.get(OWNER, added[0]).boundPageId, null)
  assert.deepEqual(readFileSync(restarted.sourcePath(OWNER, added[0])), PNG)
  assert.throws(() => restarted.beginFill(OWNER, added[0], 'new-page'), /核对/)
  restarted.resetUsage(OWNER, added[0])
  restarted.beginFill(OWNER, added[0], 'new-page')
  restarted.finishFill(OWNER, added[0], filled)
  assert.equal(restartedClient.calls.length, 0)
})

test('only requested owner loads; cross-account and cross-environment task access is rejected', async t => {
  const { manager, client, source, root, recordPath } = fixture(t)
  const first = await manager.enqueue(OWNER, [source('owner-one.png')])
  const second = await manager.enqueue(OTHER, [source('owner-two.png')])
  client.complete(0)
  client.complete(1)
  await eventually(() => manager.get(OWNER, first.added[0]).recognitionStatus === 'ready')
  assert.throws(() => manager.get(OTHER, first.added[0]), /不属于/)
  assert.throws(() => manager.sourcePath(`${OWNER}-different-environment`, first.added[0]), /不属于/)
  assert.throws(() => manager.get(OWNER, '../escape'), /无效/)
  manager.shutdown()
  writeFileSync(recordPath(OTHER, second.added[0]), '{corrupt}')
  const restarted = new PurchaseQueueManager(root, new FakeClient(), () => {})
  t.after(() => restarted.shutdown())
  assert.equal(restarted.list(OWNER).length, 1)
  assert.equal(readFileSync(recordPath(OTHER, second.added[0]), 'utf8'), '{corrupt}')
  assert.equal(restarted.list(OTHER).length, 0)
  assert.ok(readdirSync(join(root, createHash('sha256').update(OTHER).digest('hex'))).some(name => name.includes('.corrupt-')))
})

test('task and page claims are exclusive; partial results stay on the same page until explicitly reset', async t => {
  const { manager, client, source } = fixture(t)
  const { added } = await manager.enqueue(OWNER, [source('one.png'), source('two.png')])
  client.complete(0); client.complete(1)
  await eventually(() => manager.list(OWNER).every(task => task.recognitionStatus === 'ready'))
  manager.beginFill(OWNER, added[0], 'page-one')
  assert.throws(() => manager.beginFill(OWNER, added[0], 'page-one'), /正在代填/)
  assert.throws(() => manager.beginFill(OWNER, added[0], 'page-two'), /正在代填/)
  assert.throws(() => manager.beginFill(OWNER, added[1], 'page-one'), /另一张票据/)
  manager.finishFill(OWNER, added[0], partial)
  assert.equal(manager.get(OWNER, added[0]).usageStatus, 'partial')
  assert.throws(() => manager.resetUsage(OWNER, added[0]), /关闭/)
  assert.throws(() => manager.beginFill(OWNER, added[0], 'page-two'), /其他单据页/)
  manager.beginFill(OWNER, added[0], 'page-one')
  manager.finishFill(OWNER, added[0], filled)
  manager.retainPages(OWNER, [])
  assert.equal(manager.get(OWNER, added[0]).usageStatus, 'filled')
  assert.throws(() => manager.beginFill(OWNER, added[0], 'page-two'), /核对/)
  manager.resetUsage(OWNER, added[0])
  manager.beginFill(OWNER, added[0], 'page-two')
  assert.equal(client.calls.length, 2)
})

test('closed page makes active fill uncertain and a late callback cannot overwrite a new fill', async t => {
  const { manager, client, source } = fixture(t)
  const { added } = await manager.enqueue(OWNER, [source('one.png')])
  client.complete(0)
  await eventually(() => manager.get(OWNER, added[0]).recognitionStatus === 'ready')
  manager.beginFill(OWNER, added[0], 'closed-page')
  manager.retainPages(OWNER, [])
  assert.equal(manager.get(OWNER, added[0]).usageStatus, 'uncertain')
  assert.throws(() => manager.resetUsage(OWNER, added[0]), /等待代填结束/)
  manager.finishFill(OWNER, added[0], filled)
  assert.equal(manager.get(OWNER, added[0]).usageStatus, 'uncertain')
  manager.resetUsage(OWNER, added[0])
  manager.beginFill(OWNER, added[0], 'new-page')
  manager.finishFill(OWNER, added[0], partial)
  assert.equal(manager.get(OWNER, added[0]).usageStatus, 'partial')
})

test('cancel and retry hold the concurrency slot until the cancelled request settles and ignore late output', async t => {
  const { manager, client, source } = fixture(t, { concurrency: 1 })
  const { added } = await manager.enqueue(OWNER, [source('one.png'), source('two.png')])
  manager.cancel(OWNER, added[0])
  assert.equal(client.calls[0].options.signal?.aborted, true)
  manager.retry(OWNER, added[0])
  assert.equal(client.calls.length, 1)
  client.calls[0].progress({ stage: 'completed', current: 1, total: 1, message: '迟到进度' })
  assert.notEqual(manager.get(OWNER, added[0]).message, '迟到进度')
  client.complete(0, document('stale.png'))
  await eventually(() => client.calls.length === 2)
  assert.equal(manager.get(OWNER, added[0]).result, null)
  assert.equal(manager.get(OWNER, added[0]).recognitionStatus, 'recognizing')
  client.complete(1)
  await eventually(() => client.calls.length === 3)
  assert.equal(manager.get(OWNER, added[0]).recognitionStatus, 'ready')
  client.complete(2)
  await eventually(() => manager.get(OWNER, added[1]).recognitionStatus === 'ready')
})

test('suspending pauses queued work and resume waits for an aborted attempt to settle', async t => {
  const { manager, client, source } = fixture(t, { concurrency: 1 })
  const { added } = await manager.enqueue(OWNER, [source('one.png'), source('two.png')])
  manager.suspend(OWNER)
  assert.ok(manager.list(OWNER).every(task => task.recognitionStatus === 'paused'))
  manager.activate(OWNER)
  assert.equal(client.calls.length, 1)
  client.complete(0)
  await eventually(() => client.calls.length === 2)
  assert.equal(manager.get(OWNER, added[0]).result, null)
  client.complete(1)
  await eventually(() => client.calls.length === 3)
  client.complete(2)
  await eventually(() => manager.list(OWNER).every(task => task.recognitionStatus === 'ready'))
})

test('scheduler rotates active owners rather than draining one account first', async t => {
  const { manager, client, source } = fixture(t, { concurrency: 1 })
  const first = await manager.enqueue(OWNER, [source('one.png'), source('two.png')])
  const second = await manager.enqueue(OTHER, [source('other.png')])
  client.complete(0)
  await eventually(() => client.calls.length === 2)
  assert.equal(manager.get(OTHER, second.added[0]).recognitionStatus, 'recognizing')
  assert.equal(manager.get(OWNER, first.added[1]).recognitionStatus, 'queued')
  client.complete(1)
  await eventually(() => client.calls.length === 3)
  client.complete(2)
  await eventually(() => manager.get(OWNER, first.added[1]).recognitionStatus === 'ready')
})

test('interrupted recognition is restored as paused and resumes using the cached copy', async t => {
  const { manager, client, source, root, recordPath } = fixture(t)
  const original = source('resume.png')
  const { added } = await manager.enqueue(OWNER, [original])
  const persisted = readFileSync(recordPath(OWNER, added[0]), 'utf8')
  manager.shutdown()
  assert.equal(client.calls[0].options.signal?.aborted, true)
  writeFileSync(recordPath(OWNER, added[0]), persisted)
  rmSync(original)
  const resumedClient = new FakeClient()
  const restarted = new PurchaseQueueManager(root, resumedClient, () => {})
  t.after(() => restarted.shutdown())
  assert.equal(restarted.list(OWNER)[0].recognitionStatus, 'paused')
  restarted.activate(OWNER)
  assert.equal(resumedClient.calls.length, 1)
  assert.equal(existsSync(resumedClient.calls[0].path), true)
  resumedClient.complete(0)
  await eventually(() => restarted.get(OWNER, added[0]).recognitionStatus === 'ready')
})

test('invalid files are rejected independently, files over the limit never enter the queue', async t => {
  const { manager, client, source, directory } = fixture(t, { maxUploadBytes: 100 })
  const wrong = source('wrong.png')
  writeFileSync(wrong, 'not an image')
  const huge = source('huge.png')
  writeFileSync(huge, Buffer.concat([PNG, Buffer.alloc(101)]))
  const missing = join(directory, 'missing.png')
  const result = await manager.enqueue(OWNER, [wrong, huge, source('unsupported.txt'), missing, source('good.png')])
  assert.deepEqual(result.errors.map(error => error.fileName), ['wrong.png', 'huge.png', 'unsupported.txt', 'missing.png'])
  assert.ok(result.errors.every(error => !error.message.includes(directory)))
  assert.equal(result.errors.find(error => error.fileName === 'missing.png')?.message, '文件不存在或已被移动，请重新添加票据')
  assert.equal(result.added.length, 1)
  assert.equal(client.calls.length, 1)
  assert.equal(basename(client.calls[0].path), 'source.png')
})

test('incomplete result can be retried but cannot be claimed for autofill', async t => {
  const { manager, client, source } = fixture(t)
  const { added } = await manager.enqueue(OWNER, [source('incomplete.png')])
  client.complete(0, document('incomplete.png', false))
  await eventually(() => manager.get(OWNER, added[0]).recognitionStatus === 'ready')
  assert.throws(() => manager.beginFill(OWNER, added[0], 'page'), /代填条件/)
  manager.retry(OWNER, added[0])
  assert.equal(client.calls.length, 2)
  client.complete(1)
  await eventually(() => manager.get(OWNER, added[0]).readyForAutofill)
})

test('removing an active owner invalidates late results and keeps other account cache', async t => {
  const { manager, client, source, recordPath } = fixture(t)
  const first = await manager.enqueue(OWNER, [source('one.png')])
  const second = await manager.enqueue(OTHER, [source('two.png')])
  manager.removeOwner(OWNER)
  assert.equal(client.calls[0].options.signal?.aborted, true)
  client.complete(0)
  client.complete(1)
  await eventually(() => manager.get(OTHER, second.added[0]).recognitionStatus === 'ready')
  assert.equal(existsSync(recordPath(OWNER, first.added[0])), false)
  assert.equal(existsSync(recordPath(OTHER, second.added[0])), true)
  assert.deepEqual(manager.list(OWNER), [])
})

test('restored queue starts oldest imported task even when directory UUID order differs', async t => {
  const { manager, source, root, recordPath } = fixture(t, { concurrency: 1 })
  const { added } = await manager.enqueue(OWNER, [source('one.png'), source('two.png'), source('three.png')])
  manager.shutdown()
  const newestToOldest = [...added].sort()
  for (const [index, id] of newestToOldest.entries()) {
    const path = recordPath(OWNER, id)
    const record = JSON.parse(readFileSync(path, 'utf8'))
    record.task.createdAt = 10_000 - index * 1000
    writeFileSync(path, JSON.stringify(record))
  }
  const resumedClient = new FakeClient()
  const restarted = new PurchaseQueueManager(root, resumedClient, () => {}, { concurrency: 1 })
  t.after(() => restarted.shutdown())
  restarted.activate(OWNER)
  assert.equal(resumedClient.calls[0].path, restarted.sourcePath(OWNER, newestToOldest.at(-1)!))
})

test('recognition result is never published ready when its local write fails', async t => {
  const { manager, client, source, recordPath } = fixture(t)
  const { added } = await manager.enqueue(OWNER, [source('one.png')])
  const directory = dirname(recordPath(OWNER, added[0]))
  const moved = `${directory}.offline`
  renameSync(directory, moved)
  client.complete(0)
  await eventually(() => manager.get(OWNER, added[0]).recognitionStatus === 'failed')
  assert.equal(manager.get(OWNER, added[0]).readyForAutofill, false)
  assert.equal(manager.get(OWNER, added[0]).result, null)
  assert.equal(JSON.parse(readFileSync(join(moved, 'task.json'), 'utf8')).task.recognitionStatus, 'recognizing')
  renameSync(moved, directory)
  manager.retry(OWNER, added[0])
  client.complete(1)
  await eventually(() => manager.get(OWNER, added[0]).recognitionStatus === 'ready')
})

test('failed fill-state persistence exposes uncertainty and permits same-page recovery after disk repair', async t => {
  const { manager, client, source, recordPath } = fixture(t)
  const { added } = await manager.enqueue(OWNER, [source('one.png')])
  client.complete(0)
  await eventually(() => manager.get(OWNER, added[0]).recognitionStatus === 'ready')
  manager.beginFill(OWNER, added[0], 'page-one')
  const directory = dirname(recordPath(OWNER, added[0]))
  const moved = `${directory}.offline`
  renameSync(directory, moved)
  assert.throws(() => manager.finishFill(OWNER, added[0], filled))
  assert.equal(manager.get(OWNER, added[0]).usageStatus, 'uncertain')
  assert.equal(manager.get(OWNER, added[0]).boundPageId, 'page-one')
  assert.equal(JSON.parse(readFileSync(join(moved, 'task.json'), 'utf8')).task.usageStatus, 'filling')
  renameSync(moved, directory)
  manager.beginFill(OWNER, added[0], 'page-one')
  manager.finishFill(OWNER, added[0], filled)
  assert.equal(manager.get(OWNER, added[0]).usageStatus, 'filled')
  assert.equal(client.calls.length, 1)
})

test('sign-out during batch import keeps later copies paused and never resumes external requests', async t => {
  const { manager, client, source } = fixture(t, { concurrency: 1 })
  client.onCall = () => { manager.suspend(OWNER) }
  const { added } = await manager.enqueue(OWNER, [source('one.png'), source('two.png'), source('three.png')])
  assert.equal(added.length, 3)
  assert.equal(client.calls.length, 1)
  assert.ok(manager.list(OWNER).every(task => task.recognitionStatus === 'paused'))
  client.complete(0)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(client.calls.length, 1)
  assert.ok(manager.list(OWNER).every(task => manager.get(OWNER, task.taskId).result === null))
})

test('missing cached image reports a generic message without exposing the local cache path', async t => {
  const { manager, source, root } = fixture(t)
  const { added } = await manager.enqueue(OWNER, [source('one.png')])
  rmSync(manager.sourcePath(OWNER, added[0]))
  assert.throws(() => manager.sourcePath(OWNER, added[0]), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, '缓存原图不存在，请重新添加票据')
    assert.equal(error.message.includes(root), false)
    return true
  })
})
