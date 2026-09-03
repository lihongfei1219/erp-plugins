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
  sessions.setPending({
    sessionId: 'session-a',
    businessId: 'unit-initial-approval',
    token: 'token-a',
    filePath: 'unit.pdf',
    pageCount: 2
  })

  assert.throws(
    () => sessions.takePending('session-a', 'goods-receipt', 'token-a'),
    /其他业务/
  )
  assert.equal(
    sessions.takePending('session-a', 'unit-initial-approval', 'token-a').filePath,
    'unit.pdf'
  )
})

test('completed extraction can only be retrieved by its own business', () => {
  const sessions = new WorkflowSessionManager()
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

test('goods receipt fixture is isolated from the unit initial approval fixture', () => {
  const goodsReceiptScript = buildFixtureAutofillScript('goods-receipt')
  const unitInitialApprovalScript = buildFixtureAutofillScript('unit-initial-approval')

  assert.match(goodsReceiptScript, /吉林省信茂药业有限公司/)
  assert.match(goodsReceiptScript, /咳特灵胶囊/)
  assert.match(goodsReceiptScript, /咽炎片/)
  assert.match(goodsReceiptScript, /"populateBlankRows":true/)
  assert.match(goodsReceiptScript, /batchNumber/)
  assert.doesNotMatch(goodsReceiptScript, /示例医药有限公司/)
  assert.match(unitInitialApprovalScript, /示例医药有限公司/)
  assert.doesNotMatch(unitInitialApprovalScript, /吉林省信茂药业有限公司/)
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
  assert.doesNotMatch(purchaseOrderScript, /咳特灵胶囊/)
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

test('goods receipt fixture populates two rows in an empty ERP grid', async () => {
  class FakeInput {
    value = ''
    disabled = false
    readOnly = false
    dispatchEvent(): void {}
  }
  class FakeSelect extends FakeInput {}
  class FakeTextArea extends FakeInput {}
  class FakeEvent {}
  class FakeCell {
    value = ''
    setValue(value: string): void { this.value = value }
    getValue(): string { return this.value }
  }

  const fieldNames = [
    'SPMC', 'GG', 'SCCS', 'DW', 'DJ', 'DDSL', 'DHSL', 'SHSL', 'JSSL',
    'SPPH', 'SCRQ', 'YXQZ', 'SPM', 'JX', 'BZ'
  ]
  const createRow = () => {
    const rowCells = Object.fromEntries(fieldNames.map((field) => [field, new FakeCell()]))
    return { cells: () => rowCells }
  }
  const rows = [createRow()]
  const elements = new Map([
    ['DWMC', new FakeInput()],
    ['QYRQ', new FakeInput()],
    ['SHDJBZ', new FakeTextArea()]
  ])
  const pageWindow = {
    setTimeout,
    gridEditBody: { getRows: () => rows },
    gridhandler: () => rows.push(createRow())
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
    buildFixtureAutofillScript('goods-receipt'),
    context
  ) as { filledHeaderFields: number; filledDetailRows: number; skippedFields: string[] }

  assert.equal(result.filledHeaderFields, 3)
  assert.equal(result.filledDetailRows, 2)
  assert.equal(result.skippedFields.length, 0)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].cells().SPMC.value, '咳特灵胶囊')
  assert.equal(rows[0].cells().DHSL.value, '400')
  assert.equal(rows[1].cells().SPMC.value, '咽炎片')
  assert.equal(rows[1].cells().SHSL.value, '240')
  assert.equal(elements.get('DWMC')?.value, '吉林省信茂药业有限公司')
})
