import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import type { BusinessExtraction } from '../src/shared/business'
import { resolveBusinessId, toPageContext } from '../src/main/businesses/page-registry'
import { WorkflowSessionManager } from '../src/main/workflow-session-manager'
import { buildFixtureAutofillScript } from '../src/main/erp-autofill'

const unitExtraction = {
  documentType: 'unit-initial-approval'
} as BusinessExtraction

test('recognizes each supported ERP page without sharing match rules', () => {
  assert.equal(
    resolveBusinessId({
      ename: 'SPSHDJ',
      cname: '商品收货登记',
      mode: 'Add',
      title: '商品收货管理',
      frameUrl: 'http://erp.example/ZhiDan/ZhiDan.aspx?Type=Add',
      elementIds: ['DWMC', 'QYRQ'],
      visible: true
    }),
    'goods-receipt'
  )
  assert.equal(
    resolveBusinessId({
      ename: null,
      cname: '购货单位首营登记',
      mode: 'Add',
      title: '单位首营审批',
      frameUrl: 'http://erp.example/ZhiDan/ZhiDan.aspx?Type=Add',
      elementIds: ['DWMC', 'YYZZH'],
      visible: true
    }),
    'unit-initial-approval'
  )
  assert.equal(
    resolveBusinessId({
      ename: 'CGDD',
      cname: '采购订单',
      mode: 'Add',
      title: '采购订单管理',
      frameUrl: 'http://erp.example/ZhiDan/ZhiDan.aspx?Type=Add',
      elementIds: ['DWMC', 'QYRQ', 'FKFS'],
      visible: true
    }),
    'purchase-order'
  )
})
test('page context requires add mode before autofill is enabled', () => {
  const context = toPageContext({
    ename: 'SPSHDJ',
    cname: '商品收货登记',
    mode: 'Edit',
    title: '商品收货管理',
    frameUrl: 'http://erp.example/ZhiDan/ZhiDan.aspx?Type=Edit',
    elementIds: ['DWMC', 'QYRQ'],
    visible: true
  })
  assert.equal(context.businessId, 'goods-receipt')
  assert.equal(context.supported, true)
  assert.equal(context.isNew, false)
})

test('pending document tokens cannot cross business boundaries', () => {
  const sessions = new WorkflowSessionManager()
  sessions.bindToPage('session-a', 'unit-initial-approval', 'page-a')
  sessions.setPending({
    sessionId: 'session-a',
    businessId: 'unit-initial-approval',
    token: 'token-a',
    items: [{
      id: 'item-a', filePath: 'unit.pdf', fileName: 'unit.pdf', status: 'queued',
      message: 'waiting', pageCount: null, result: null
    }]
  })

  assert.throws(
    () => sessions.beginPending('session-a', 'goods-receipt', 'token-a'),
    /其他业务/
  )
  assert.equal(
    sessions.beginPending('session-a', 'unit-initial-approval', 'token-a').items[0].filePath,
    'unit.pdf'
  )
})

test('completed extraction can only be retrieved by its own business', () => {
  const sessions = new WorkflowSessionManager()
  sessions.bindToPage('session-a', 'unit-initial-approval', 'page-a')
  sessions.complete('session-a', 'unit-initial-approval', unitExtraction)

  assert.throws(
    () => sessions.getExtraction('session-a', 'goods-receipt'),
    /其他业务/
  )
  assert.equal(
    sessions.getExtraction('session-a', 'unit-initial-approval').documentType,
    'unit-initial-approval'
  )
})

test('mismatched extraction is rejected before it enters a session', () => {
  const sessions = new WorkflowSessionManager()
  assert.throws(
    () => sessions.complete('session-a', 'goods-receipt', unitExtraction),
    /业务类型不一致/
  )
})

test('cached extraction remains reusable while its page is open, including hidden pages', () => {
  const sessions = new WorkflowSessionManager()
  sessions.bindToPage('session-a', 'unit-initial-approval', 'page-a')
  sessions.complete('session-a', 'unit-initial-approval', unitExtraction)
  sessions.retainOpenPages(['page-b', 'page-a'])
  assert.equal(sessions.getPageId('session-a', 'unit-initial-approval'), 'page-a')
  assert.equal(sessions.getExtraction('session-a', 'unit-initial-approval'), unitExtraction)
  assert.equal(sessions.getExtraction('session-a', 'unit-initial-approval'), unitExtraction)
})

test('closing one page clears only its cached data and rejects late OCR completion', () => {
  const sessions = new WorkflowSessionManager()
  for (const id of ['a', 'b']) {
    sessions.bindToPage(`session-${id}`, 'unit-initial-approval', `page-${id}`)
    sessions.complete(`session-${id}`, 'unit-initial-approval', unitExtraction)
  }
  sessions.bindToPage('pending-a', 'unit-initial-approval', 'page-a')
  sessions.setPending({
    sessionId: 'pending-a', businessId: 'unit-initial-approval', token: 'token',
    items: [{ id: 'item', filePath: 'x.pdf', fileName: 'x.pdf', status: 'queued', message: 'waiting', pageCount: null, result: null }]
  })
  sessions.retainOpenPages(['page-b'])
  assert.throws(() => sessions.getExtraction('session-a', 'unit-initial-approval'), /失效/)
  assert.throws(() => sessions.complete('session-a', 'unit-initial-approval', unitExtraction), /已关闭/)
  assert.throws(() => sessions.beginPending('pending-a', 'unit-initial-approval', 'token'), /失效/)
  assert.equal(sessions.getExtraction('session-b', 'unit-initial-approval'), unitExtraction)
  sessions.bindToPage('new-session', 'unit-initial-approval', 'reopened-page-a')
  assert.throws(() => sessions.getExtraction('new-session', 'unit-initial-approval'), /失效/)
})

test('closing the client also prevents unfinished requests from restoring cached results', () => {
  const sessions = new WorkflowSessionManager()
  sessions.bindToPage('session-a', 'unit-initial-approval', 'page-a')
  sessions.clear()
  assert.throws(() => sessions.complete('session-a', 'unit-initial-approval', unitExtraction), /已关闭/)
  assert.throws(() => sessions.setPending({
    sessionId: 'session-a', businessId: 'unit-initial-approval', token: 'token',
    items: [{ id: 'item', filePath: 'x.pdf', fileName: 'x.pdf', status: 'queued', message: 'waiting', pageCount: null, result: null }]
  }), /已关闭/)
})

test('goods receipt fixture is isolated from the unit initial approval fixture', () => {
  const goodsReceiptScript = buildFixtureAutofillScript('goods-receipt')
  const unitInitialApprovalScript = buildFixtureAutofillScript('unit-initial-approval')

  assert.match(goodsReceiptScript, /吉林省润强药业有限公司/)
  assert.match(goodsReceiptScript, /安神补心丸/)
  assert.match(goodsReceiptScript, /硫酸庆大霉素碳酸铋胶囊/)
  assert.match(goodsReceiptScript, /batchNumber/)
  assert.doesNotMatch(goodsReceiptScript, /示例医药有限公司/)
  assert.match(unitInitialApprovalScript, /示例医药有限公司/)
  assert.doesNotMatch(unitInitialApprovalScript, /吉林省润强药业有限公司/)
})

test('purchase order fixture is isolated and keeps all four source rows', () => {
  const purchaseOrderScript = buildFixtureAutofillScript('purchase-order')
  const goodsReceiptScript = buildFixtureAutofillScript('goods-receipt')

  assert.match(purchaseOrderScript, /江西康强医药有限公司/)
  assert.match(purchaseOrderScript, /健胃消食片/)
  assert.match(purchaseOrderScript, /"quantity":17100/)
  assert.match(purchaseOrderScript, /"quantity":120/)
  assert.match(purchaseOrderScript, /"quantity":180/)
  assert.match(purchaseOrderScript, /"quantity":12600/)
  assert.match(purchaseOrderScript, /"taxIncludedUnitPrice":4\.221/)
  assert.doesNotMatch(purchaseOrderScript, /安神补心丸/)
  assert.doesNotMatch(goodsReceiptScript, /江西康强医药有限公司/)
})

test('purchase order fixture fills four separate ERP rows in source order', async () => {
  class FakeInput {
    value = ''
    disabled = false
    readOnly = false
    dispatchEvent(): void {}
  }
  class FakeSelect extends FakeInput {
    options: Array<{ value: string }> = []
  }
  class FakeTextArea extends FakeInput {}
  class FakeEvent {}
  class FakeCell {
    value = ''
    constructor(private readonly changed?: () => void) {}
    setValue(value: string): void {
      this.value = value
      this.changed?.()
    }
    getValue(): string { return this.value }
  }

  const createItemCells = (): Record<string, FakeCell> => {
    const cells: Record<string, FakeCell> = {}
    const updateAmount = () => {
      const quantity = Number(cells.SL?.value)
      const price = Number(cells.DJ?.value)
      if (Number.isFinite(quantity) && Number.isFinite(price)) {
        cells.JE.value = String(quantity * price)
      }
    }
    cells.SPMC = new FakeCell()
    cells.SL = new FakeCell(updateAmount)
    cells.DJ = new FakeCell(updateAmount)
    cells.JE = new FakeCell()
    cells.SPBH = new FakeCell()
    cells.GG = new FakeCell()
    cells.SCCS = new FakeCell()
    return cells
  }
  const protectedCells = createItemCells()
  protectedCells.SPMC.value = '用户手工商品'
  const itemRows = [createItemCells()]
  const rows: Array<{ cells: () => Record<string, FakeCell> }> = [
    { cells: () => protectedCells },
    { cells: () => itemRows[0] }
  ]
  const elements = new Map<string, FakeInput>([
    ['DWMC', new FakeInput()],
    ['DWBH', new FakeInput()],
    ['CYDW', new FakeInput()],
    ['QYRQ', new FakeInput()],
    ['BZ', new FakeTextArea()]
  ])
  const pageWindow = {
    setTimeout,
    gridEditBody: { getRows: () => rows },
    gridhandler: () => {
      const cells = createItemCells()
      itemRows.push(cells)
      rows.push({ cells: () => cells })
    }
  }
  const context = {
    window: pageWindow,
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    setTimeout
  }

  const result = await vm.runInNewContext(
    buildFixtureAutofillScript('purchase-order'),
    context
  ) as { filledHeaderFields: number; filledDetailRows: number; skippedFields: string[] }

  assert.equal(result.filledHeaderFields, 4)
  assert.equal(result.filledDetailRows, 4)
  assert.equal(result.skippedFields.length, 0)
  assert.equal(elements.get('DWMC')?.value, '江西康强医药有限公司')
  assert.equal(itemRows.length, 4)
  assert.deepEqual(itemRows.map((cells) => cells.SPMC.value), [
    '健胃消食片',
    '健胃消食片',
    '健胃消食片',
    '健胃消食片'
  ])
  assert.deepEqual(itemRows.map((cells) => cells.SL.value), ['17100', '120', '180', '12600'])
  assert.deepEqual(itemRows.map((cells) => cells.DJ.value), ['4.221', '4.221', '4.221', '4.221'])
  assert.deepEqual(itemRows.map((cells) => cells.JE.value), [
    '72179.1',
    '506.52',
    '759.78',
    '53184.6'
  ])
  assert.equal(protectedCells.SPMC.value, '用户手工商品')
})

test('purchase order autofill does not call ERP head reference handler after its target is cleared', async () => {
  class FakeElement {
    style = { visibility: '', display: '' }
    getClientRects(): Array<object> { return [{}] }
  }
  class FakeInput extends FakeElement {
    value = ''
    disabled = false
    readOnly = false
    dispatchEvent(): void {}
  }
  class FakeSelect extends FakeInput {
    options: Array<{ value: string }> = []
  }
  class FakeTextArea extends FakeInput {}
  class FakeEvent {}

  const dialog = new FakeElement()
  const elements = new Map<string, FakeElement>([
    ['DWMC', new FakeInput()],
    ['DWBH', new FakeInput()],
    ['CYDW', new FakeInput()],
    ['QYRQ', new FakeInput()],
    ['BZ', new FakeTextArea()],
    ['dlgHeadCzDiv', dialog]
  ])
  const referenceRow = {
    rowData: {
      supplier: '江西康强医药有限公司',
      carrier: '江西仁济医药有限公司'
    },
    setSelected(): void {}
  }
  let unsafeHandlerCalls = 0
  const pageWindow = {
    setTimeout,
    headczobj: null,
    headczing: true,
    headCz: { getRows: () => [referenceRow] },
    doDjHeadCz: () => {
      dialog.style.visibility = 'visible'
      dialog.style.display = 'block'
    },
    doHeadCz: () => {
      unsafeHandlerCalls += 1
      throw new Error("Cannot set properties of null (setting 'doevent')")
    }
  }
  const context = {
    window: pageWindow,
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    setTimeout
  }

  const result = await vm.runInNewContext(
    buildFixtureAutofillScript('purchase-order'),
    context
  ) as { skippedFields: string[] }

  assert.equal(unsafeHandlerCalls, 0)
  assert.equal(dialog.style.visibility, 'hidden')
  assert.ok(result.skippedFields.some((field) => field.includes('DWMC')))
})
