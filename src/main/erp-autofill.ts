import unitInitialApprovalFixture from '../../test-data/unit-initial-approval.example.json'
import goodsReceiptFixture from '../../test-data/goods-receipt.example.json'
import purchaseOrderFixture from '../../test-data/purchase-order.example.json'
import type { ErpAutofillResult } from '../shared/erp'
import type {
  BusinessExtraction,
  BusinessId,
  GoodsReceiptExtraction,
  GoodsReceiptHeader,
  GoodsReceiptItem,
  PurchaseOrderExtraction,
  PurchaseOrderHeader,
  PurchaseOrderItem,
  UnitInitialApprovalExtraction,
  UnitInitialApprovalHeader
} from '../shared/business'

interface QualificationRow {
  dataType: string
  certificateNo: string | null
  issuingAuthority: string | null
  issueDate: string | null
  expiryDate: string | null
  expiryControl: boolean
  materialProvided?: boolean
}

interface AutofillPayload {
  header: Record<string, string>
  qualificationRows: QualificationRow[]
}

interface GridCell {
  setValue: (value: string, eventTrigger?: boolean) => void
  getValue?: () => unknown
  getElement?: () => HTMLElement | null
  value?: unknown
}

interface GridRow {
  cells: () => Record<string, GridCell | undefined>
  rowData?: Record<string, unknown>
  setSelected?: (selected: boolean) => void
}

interface GridController {
  getRows: () => GridRow[]
  rows?: GridRow[]
  getSelectedRows?: () => GridRow[]
}

interface ErpPageWindow extends Window {
  gridEditBody?: GridController
  gridhandler?: (operation: string, gridBit: string) => void
  gridCz?: GridController
  headCz?: GridController
  afterGridEdit?: (event: Record<string, unknown>) => void
  doDjHeadCz?: (element: HTMLInputElement) => void
  doHeadCz?: (operation: string) => void
  doGridCz?: (operation: string) => void
  headczobj?: unknown
  currCZE?: unknown
  headczing?: boolean
  bodyczing?: boolean
}

interface PageAutofillResult {
  filledHeaderFields: number
  filledDetailRows: number
  skippedFields: string[]
}

function mapUnitType(value: string | null): string | null {
  if (!value) return null
  if (value.includes('批发')) return '批发企业'
  if (value.includes('零售连锁')) return '零售连锁'
  if (value.includes('零售')) return '零售企业'
  if (value.includes('医疗')) return '医疗机构'
  if (value.includes('生产')) return '生产企业'
  return value
}

function mapInvoiceType(value: string | null): string | null {
  if (!value) return null
  if (value.includes('专')) return '专票'
  if (value.includes('普')) return '普票'
  return value
}

function buildAutofillPayload(
  sourceHeader: UnitInitialApprovalHeader,
  qualificationRows: QualificationRow[]
): AutofillPayload {
  const expiringQualifications = qualificationRows.filter((row) => row.expiryDate)
  const earliestExpiryDate = expiringQualifications
    .map((row) => row.expiryDate as string)
    .sort()[0]

  const candidates: Record<string, string | null | undefined> = {
    DWMC: sourceHeader.unitName,
    YYZZH: sourceHeader.businessLicenseNo,
    ZCDZ: sourceHeader.registeredAddress,
    CKDZ: sourceHeader.warehouseAddress,
    DWDH: sourceHeader.unitPhone,
    DWLX: mapUnitType(sourceHeader.unitType),
    CGYXM: sourceHeader.buyerName,
    CGYSFZ: sourceHeader.buyerIdCardNo,
    GSKPLX: mapInvoiceType(sourceHeader.companyInvoiceType),
    GSKHMC: sourceHeader.companyAccountName,
    GSKHZH: sourceHeader.companyBankAccount,
    SPLXDH: sourceHeader.invoiceContactPhone,
    GSKHYH: sourceHeader.companyBankName,
    GSKHSH: sourceHeader.companyTaxNo,
    ZTRXM: sourceHeader.selfPickupName,
    ZTRSFZH: sourceHeader.selfPickupIdCardNo,
    ZZDQRQ: earliestExpiryDate,
    ZZDQTX: expiringQualifications.some((row) => row.expiryControl) ? '是' : '否',
    JYFW: sourceHeader.businessScope.join(','),
    SDKCQK: sourceHeader.siteInspectionStatus,
    DWFDDBR: sourceHeader.legalRepresentative,
    DWZLFZR: sourceHeader.qualityResponsiblePerson,
    DWQYFZR: sourceHeader.enterpriseResponsiblePerson,
    SHRY: sourceHeader.receivingPerson,
    SHDH: sourceHeader.receivingPhone,
    SHDZ: sourceHeader.receivingAddress
  }

  const header = Object.fromEntries(
    Object.entries(candidates).filter((entry): entry is [string, string] => {
      const value = entry[1]
      return typeof value === 'string' && value.length > 0
    })
  )

  return {
    header,
    qualificationRows: qualificationRows
      .filter((row) => row.dataType.length > 0)
      .map((row) => ({
        ...row,
        certificateNo: row.certificateNo ?? '',
        issuingAuthority: row.issuingAuthority ?? '',
        issueDate: row.issueDate ?? ''
      })) as Array<QualificationRow & {
      certificateNo: string
      issuingAuthority: string
      issueDate: string
    }>
  }
}

function buildUnitInitialApprovalFixturePayload(): AutofillPayload {
  const header = {
    ...unitInitialApprovalFixture.erpPayload.header,
    businessScope: unitInitialApprovalFixture.rawExtractedData.drugBusinessLicense.businessScope
  } as unknown as UnitInitialApprovalHeader
  return buildAutofillPayload(
    header,
    unitInitialApprovalFixture.erpPayload.qualificationRows as QualificationRow[]
  )
}

async function runUnitInitialApprovalAutofill(payload: AutofillPayload): Promise<PageAutofillResult> {
  const pageWindow = window as ErpPageWindow
  const skippedFields: string[] = []
  let filledHeaderFields = 0

  const setElementValue = (fieldId: string, value: string): boolean => {
    const element = document.getElementById(fieldId)

    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
      skippedFields.push(fieldId)
      return false
    }

    if (element.disabled) {
      skippedFields.push(`${fieldId}（已禁用）`)
      return false
    }

    if (element instanceof HTMLSelectElement) {
      const optionExists = Array.from(element.options).some((option) => option.value === value)

      if (!optionExists) {
        skippedFields.push(`${fieldId}（没有选项“${value}”）`)
        return false
      }
    }

    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }))
    }

    return true
  }

  for (const [fieldId, value] of Object.entries(payload.header)) {
    if (setElementValue(fieldId, value)) {
      filledHeaderFields += 1
    }
  }

  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds))

  const waitForRowCount = async (expectedCount: number): Promise<boolean> => {
    const deadline = Date.now() + 10000

    while (Date.now() < deadline) {
      if ((pageWindow.gridEditBody?.getRows().length ?? 0) >= expectedCount) {
        return true
      }

      await wait(100)
    }

    return false
  }

  const getGrid = (): GridController | undefined => pageWindow.gridEditBody
  const grid = getGrid()
  const addGridRow = pageWindow.gridhandler

  if (!grid || !addGridRow) {
    skippedFields.push('证照明细表（ERP网格尚未就绪）')
    return { filledHeaderFields, filledDetailRows: 0, skippedFields }
  }

  while ((getGrid()?.getRows().length ?? 0) < payload.qualificationRows.length) {
    const expectedCount = (getGrid()?.getRows().length ?? 0) + 1
    addGridRow.call(pageWindow, 'add', 'B')

    if (!(await waitForRowCount(expectedCount))) {
      skippedFields.push(`证照明细第${expectedCount}行（新增超时）`)
      break
    }
  }

  const gridFieldMap: Record<string, (row: QualificationRow) => string> = {
    ZLLX: (row) => row.dataType,
    ZSBH: (row) => row.certificateNo ?? '',
    FZJG: (row) => row.issuingAuthority ?? '',
    FZRQ: (row) => row.issueDate ?? '',
    DQRQ: (row) => row.expiryDate ?? '',
    DQKZ: (row) => (row.expiryControl ? '是' : '否'),
    ZLTG: (row) => (row.materialProvided === false ? '否' : '是')
  }

  let filledDetailRows = 0
  const rows = getGrid()?.getRows() ?? []

  for (let rowIndex = 0; rowIndex < payload.qualificationRows.length; rowIndex += 1) {
    const gridRow = rows[rowIndex]
    const dataRow = payload.qualificationRows[rowIndex]

    if (!gridRow) {
      skippedFields.push(`证照明细第${rowIndex + 1}行`)
      continue
    }

    const cells = gridRow.cells()
    let completed = true

    for (const [fieldName, getValue] of Object.entries(gridFieldMap)) {
      const cell = cells[fieldName]

      if (!cell) {
        skippedFields.push(`证照明细第${rowIndex + 1}行.${fieldName}`)
        completed = false
        continue
      }

      cell.setValue(getValue(dataRow))
    }

    if (completed) {
      filledDetailRows += 1
    }
  }

  return { filledHeaderFields, filledDetailRows, skippedFields }
}

interface GoodsReceiptAutofillPayload {
  supplierName: string | null
  header: Record<string, string>
  items: GoodsReceiptItem[]
  populateBlankRows: boolean
}

function buildGoodsReceiptPayload(
  header: GoodsReceiptHeader,
  items: GoodsReceiptItem[],
  populateBlankRows = false
): GoodsReceiptAutofillPayload {
  const candidates: Record<string, string | number | null> = {
    QYRQ: header.departureDate,
    CYDW: header.carrierName,
    CYFS: header.transportMethod,
    SHRQ1: header.receiptDateTime,
    WBWD: header.surfaceTemperature,
    YSFS: header.transportVehicle,
    qydd: header.departurePlace,
    QYRS: header.departureDateTime,
    SHSJ: header.receiptDateTimeDetail,
    SJYSSJ: header.actualTransportHours,
    SHDJBZ: header.receiptRemark
  }
  return {
    supplierName: header.supplierName,
    header: Object.fromEntries(
      Object.entries(candidates)
        .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== '')
        .map(([key, value]) => [key, String(value)])
    ),
    items,
    populateBlankRows
  }
}

function buildGoodsReceiptFixturePayload(): GoodsReceiptAutofillPayload {
  const fixturePayload = goodsReceiptFixture.erpPayload
  return buildGoodsReceiptPayload(
    fixturePayload.header as GoodsReceiptHeader,
    fixturePayload.items.map((item) => ({ ...item, sourcePages: [1] })) as GoodsReceiptItem[],
    true
  )
}

async function runGoodsReceiptAutofill(
  payload: GoodsReceiptAutofillPayload
): Promise<PageAutofillResult> {
  const pageWindow = window as ErpPageWindow
  const skippedFields: string[] = []
  let filledHeaderFields = 0

  const setElementValue = (fieldId: string, value: string): boolean => {
    const element = document.getElementById(fieldId)
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
      skippedFields.push(fieldId)
      return false
    }
    if (element.disabled || (!(element instanceof HTMLSelectElement) && element.readOnly)) {
      skippedFields.push(`${fieldId}（只读或已禁用）`)
      return false
    }
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }))
    return true
  }

  for (const [fieldId, value] of Object.entries(payload.header)) {
    if (setElementValue(fieldId, value)) filledHeaderFields += 1
  }

  if (payload.supplierName) {
    if (payload.populateBlankRows) {
      if (setElementValue('DWMC', payload.supplierName)) filledHeaderFields += 1
    } else {
      const supplierElement = document.getElementById('DWMC')
      const currentSupplier = supplierElement instanceof HTMLInputElement
        ? supplierElement.value.trim()
        : ''
      if (currentSupplier !== payload.supplierName.trim()) {
        skippedFields.push(`单位名称（请通过ERP参照选择“${payload.supplierName}”）`)
      }
    }
  }

  const grid = pageWindow.gridEditBody
  if (!grid) {
    skippedFields.push('商品明细表（ERP网格尚未就绪）')
    return { filledHeaderFields, filledDetailRows: 0, skippedFields }
  }

  const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, '').trim()
  const cellValue = (cell: GridCell | undefined): unknown => {
    if (!cell) return ''
    if (typeof cell.getValue === 'function') return cell.getValue()
    return cell.value ?? ''
  }
  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  const waitForRowCount = async (expectedCount: number): Promise<boolean> => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if ((pageWindow.gridEditBody?.getRows().length ?? 0) >= expectedCount) return true
      await wait(100)
    }
    return false
  }

  if (payload.populateBlankRows) {
    const addGridRow = pageWindow.gridhandler
    if (!addGridRow && grid.getRows().length < payload.items.length) {
      skippedFields.push('商品明细表（无法新增测试行）')
    } else {
      while (grid.getRows().length < payload.items.length && addGridRow) {
        const expectedCount = grid.getRows().length + 1
        addGridRow.call(pageWindow, 'add', 'B')
        if (!(await waitForRowCount(expectedCount))) {
          skippedFields.push(`商品明细第${expectedCount}行（新增超时）`)
          break
        }
      }
    }
  }

  const rows = grid.getRows()
  const usedRows = new Set<GridRow>()
  let filledDetailRows = 0

  for (let itemIndex = 0; itemIndex < payload.items.length; itemIndex += 1) {
    const item = payload.items[itemIndex]
    let row = rows.find((candidate) => {
      if (usedRows.has(candidate)) return false
      const cells = candidate.cells()
      return normalize(cellValue(cells.SPMC)) === normalize(item.productName)
    })
    if (!row && payload.populateBlankRows) {
      row = rows.find((candidate) => {
        if (usedRows.has(candidate)) return false
        return normalize(cellValue(candidate.cells().SPMC)) === ''
      }) ?? rows.find((candidate) => !usedRows.has(candidate))
    }
    if (!row) {
      skippedFields.push(`商品“${item.productName}”（请先在ERP中选择对应采购订单商品）`)
      continue
    }
    usedRows.add(row)

    const cells = row.cells()
    let changed = false
    const values: Record<string, string | null> = payload.populateBlankRows
      ? {
          SPMC: item.productName,
          GG: item.specification,
          SCCS: item.manufacturer,
          DW: item.unit,
          DJ: item.unitPrice === null ? null : String(item.unitPrice),
          DDSL: item.packageQuantity === null ? null : String(item.packageQuantity),
          DHSL: item.arrivalQuantity === null ? null : String(item.arrivalQuantity),
          SHSL: item.receiptQuantity === null ? null : String(item.receiptQuantity),
          JSSL: '0',
          SPPH: item.batchNumber,
          SCRQ: item.productionDate,
          YXQZ: item.expiryDate,
          SPM: item.productName,
          JX: item.dosageForm,
          BZ: item.remark
        }
      : {
          DHSL: item.arrivalQuantity === null ? null : String(item.arrivalQuantity),
          SHSL: item.receiptQuantity === null ? null : String(item.receiptQuantity),
          BZ: item.remark
        }
    const criticalFields = new Set(payload.populateBlankRows ? ['SPMC', 'DHSL', 'SHSL'] : ['DHSL', 'SHSL'])
    for (const [fieldName, value] of Object.entries(values)) {
      if (value === null || value === '') continue
      const cell = cells[fieldName]
      if (!cell) {
        if (criticalFields.has(fieldName)) {
          skippedFields.push(`商品“${item.productName}”.${fieldName}`)
        }
        continue
      }
      cell.setValue(value)
      if (criticalFields.has(fieldName)) changed = true
    }
    if (changed) filledDetailRows += 1
  }

  return { filledHeaderFields, filledDetailRows, skippedFields }
}

interface PurchaseOrderAutofillPayload {
  supplierName: string | null
  carrierName: string | null
  transportMethod: string | null
  header: Record<string, string>
  items: PurchaseOrderItem[]
}

function buildPurchaseOrderPayload(
  sourceHeader: PurchaseOrderHeader,
  items: PurchaseOrderItem[]
): PurchaseOrderAutofillPayload {
  const candidates: Record<string, string | number | null> = {
    LCSP: sourceHeader.coldChain,
    QYRQ: sourceHeader.departureDate,
    YSSX: sourceHeader.transportTimeLimit,
    SHBZ: sourceHeader.receiptRemark,
    BZ: sourceHeader.remark,
    FZ: sourceHeader.groupName,
    FKFS: sourceHeader.paymentMethod
  }
  return {
    supplierName: sourceHeader.supplierName,
    carrierName: sourceHeader.carrierName,
    transportMethod: sourceHeader.transportMethod,
    header: Object.fromEntries(
      Object.entries(candidates)
        .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== '')
        .map(([key, value]) => [key, String(value)])
    ),
    items
  }
}

function buildPurchaseOrderFixturePayload(): PurchaseOrderAutofillPayload {
  return buildPurchaseOrderPayload(
    purchaseOrderFixture.erpPayload.header as PurchaseOrderHeader,
    purchaseOrderFixture.erpPayload.items as PurchaseOrderItem[]
  )
}

async function runPurchaseOrderAutofill(
  payload: PurchaseOrderAutofillPayload
): Promise<PageAutofillResult> {
  const pageWindow = window as ErpPageWindow
  const skippedFields: string[] = []
  let filledHeaderFields = 0
  let filledDetailRows = 0

  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  const waitUntil = async (predicate: () => boolean, timeoutMs = 12000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await wait(100)
    }
    return predicate()
  }
  const normalize = (value: unknown): string => String(value ?? '')
    .toLowerCase()
    .replace(/[\s()（）*×xX,，.。/\\\-]/g, '')
  const cellValue = (cell: GridCell | undefined): unknown => {
    if (!cell) return ''
    if (typeof cell.getValue === 'function') return cell.getValue()
    return cell.value ?? ''
  }
  const controllerRows = (controller: GridController | undefined): GridRow[] =>
    controller?.getRows?.() ?? controller?.rows ?? []
  const dialogIsVisible = (id: string): boolean => {
    const element = document.getElementById(id)
    if (!(element instanceof HTMLElement)) return false
    return element.style.visibility === 'visible' ||
      (element.style.display !== 'none' && element.getClientRects().length > 0)
  }
  const hideStaleReferenceDialog = (id: string, kind: 'head' | 'grid'): void => {
    const dialog = document.getElementById(id)
    if (dialog instanceof HTMLElement) {
      dialog.style.visibility = 'hidden'
      dialog.style.display = 'none'
    }
    if (kind === 'head') pageWindow.headczing = false
    else pageWindow.bodyczing = false
  }
  const cancelReferenceDialog = (
    id: string,
    kind: 'head' | 'grid',
    operation: ((operation: string) => void) | undefined
  ): void => {
    if (!dialogIsVisible(id)) return
    const activeReference = kind === 'head' ? pageWindow.headczobj : pageWindow.currCZE
    if (activeReference && operation) {
      try {
        operation.call(pageWindow, 'cancel')
        return
      } catch {
        // The ERP reference state can disappear while its dialog is still visible.
      }
    }
    hideStaleReferenceDialog(id, kind)
  }
  const setElementValue = (fieldId: string, value: string): boolean => {
    const element = document.getElementById(fieldId)
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
      skippedFields.push(fieldId)
      return false
    }
    if (element.disabled || (!(element instanceof HTMLSelectElement) && element.readOnly)) {
      skippedFields.push(`${fieldId}（只读或已禁用）`)
      return false
    }
    if (element instanceof HTMLSelectElement) {
      const optionExists = Array.from(element.options).some((option) => option.value === value)
      if (!optionExists) {
        skippedFields.push(`${fieldId}（没有选项“${value}”）`)
        return false
      }
    }
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }))
    return true
  }
  const scoreReferenceRow = (
    row: GridRow,
    primary: string,
    hints: Array<string | null>
  ): number => {
    const values = Object.values(row.rowData ?? {}).map(normalize).filter(Boolean)
    const primaryValue = normalize(primary)
    if (!primaryValue || !values.some((value) => value.includes(primaryValue) || primaryValue.includes(value))) {
      return -1
    }
    let score = values.some((value) => value === primaryValue) ? 100 : 60
    for (const hint of hints) {
      const hintValue = normalize(hint)
      if (!hintValue) continue
      if (values.some((value) => value === hintValue)) score += 20
      else if (values.some((value) => value.includes(hintValue) || hintValue.includes(value))) score += 10
    }
    return score
  }
  const selectBestReferenceRow = (
    controller: GridController | undefined,
    primary: string,
    hints: Array<string | null>
  ): boolean => {
    const scored = controllerRows(controller)
      .map((row) => ({ row, score: scoreReferenceRow(row, primary, hints) }))
      .filter((candidate) => candidate.score >= 0)
      .sort((left, right) => right.score - left.score)
    if (scored.length === 0) return false
    if (scored.length > 1 && scored[0].score === scored[1].score) return false
    for (const row of controllerRows(controller)) row.setSelected?.(false)
    scored[0].row.setSelected?.(true)
    return typeof scored[0].row.setSelected === 'function'
  }
  const resolveHeadReference = async (
    fieldId: string,
    value: string,
    dependentFieldId?: string
  ): Promise<boolean> => {
    const element = document.getElementById(fieldId)
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) {
      skippedFields.push(`${fieldId}（参照字段不可用）`)
      return false
    }

    if (typeof pageWindow.doDjHeadCz !== 'function' || typeof pageWindow.doHeadCz !== 'function') {
      element.value = value
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }

    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    try {
      pageWindow.doDjHeadCz(element)
    } catch {
      skippedFields.push(`${fieldId}（启动 ERP 参照失败）`)
      return false
    }

    let selectionSubmitted = false
    let selectionFailed = false
    const resolved = await waitUntil(() => {
      const dependent = dependentFieldId ? document.getElementById(dependentFieldId) : null
      if (
        dependent instanceof HTMLInputElement && dependent.value.trim() &&
        normalize(element.value) === normalize(value)
      ) return true

      if (dialogIsVisible('dlgHeadCzDiv') && controllerRows(pageWindow.headCz).length > 0) {
        if (selectionSubmitted) return false
        selectionSubmitted = true
        if (!selectBestReferenceRow(pageWindow.headCz, value, [])) {
          selectionFailed = true
          return true
        }
        if (!pageWindow.headczobj) {
          selectionFailed = true
          hideStaleReferenceDialog('dlgHeadCzDiv', 'head')
          return true
        }
        try {
          pageWindow.doHeadCz?.('ok')
        } catch {
          selectionFailed = true
          hideStaleReferenceDialog('dlgHeadCzDiv', 'head')
          return true
        }
        return false
      }

      return !dependentFieldId && pageWindow.headczing === false &&
        !dialogIsVisible('dlgHeadCzDiv') &&
        normalize(element.value) === normalize(value)
    })
    if (resolved && !selectionFailed) {
      await wait(250)
      return true
    }
    cancelReferenceDialog('dlgHeadCzDiv', 'head', pageWindow.doHeadCz)
    skippedFields.push(`${fieldId}（ERP 参照中未唯一匹配“${value}”）`)
    return false
  }
  const waitForRowCount = async (expectedCount: number): Promise<boolean> =>
    waitUntil(() => (pageWindow.gridEditBody?.getRows().length ?? 0) >= expectedCount, 10000)
  const triggerCellEdit = async (
    rowIndex: number,
    fieldName: string,
    value: string
  ): Promise<boolean> => {
    const row = pageWindow.gridEditBody?.getRows()[rowIndex]
    const cell = row?.cells()[fieldName]
    if (!cell) return false
    const oldValue = cellValue(cell)
    cell.setValue(value, false)
    if (typeof pageWindow.afterGridEdit !== 'function' || typeof cell.getElement !== 'function') return true
    try {
      pageWindow.afterGridEdit({
        type: 'cellChgdExitFunc',
        cell,
        td: cell.getElement(),
        dataIndex: fieldName,
        oldValue,
        newValue: value,
        rowIndex
      })
    } catch {
      return false
    }
    return waitUntil(() => pageWindow.bodyczing !== true, 15000)
  }
  const resolveProductReference = async (
    rowIndex: number,
    item: PurchaseOrderItem
  ): Promise<boolean> => {
    const row = pageWindow.gridEditBody?.getRows()[rowIndex]
    const cell = row?.cells().SPMC
    if (!cell) return false

    if (typeof pageWindow.afterGridEdit !== 'function' || typeof cell.getElement !== 'function') {
      cell.setValue(item.productName)
      return true
    }

    const triggered = await triggerCellEdit(rowIndex, 'SPMC', item.productName)
    const hasResolvedProduct = (): boolean => {
      const cells = pageWindow.gridEditBody?.getRows()[rowIndex]?.cells()
      return Boolean(
        normalize(cellValue(cells?.SPMC)) === normalize(item.productName) &&
        (normalize(cellValue(cells?.SPBH)) || normalize(cellValue(cells?.GG)) || normalize(cellValue(cells?.SCCS)))
      )
    }
    if (triggered && hasResolvedProduct()) return true

    let selectionSubmitted = false
    let selectionFailed = false
    const resolved = await waitUntil(() => {
      if (hasResolvedProduct()) return true
      if (dialogIsVisible('dlgGridCzDiv') && controllerRows(pageWindow.gridCz).length > 0) {
        if (selectionSubmitted) return false
        selectionSubmitted = true
        const selected = selectBestReferenceRow(pageWindow.gridCz, item.productName, [
          item.specification,
          item.manufacturer,
          item.approvalNumber,
          item.marketingAuthorizationHolder
        ])
        if (!selected) {
          selectionFailed = true
          return true
        }
        if (!pageWindow.currCZE) {
          selectionFailed = true
          hideStaleReferenceDialog('dlgGridCzDiv', 'grid')
          return true
        }
        try {
          pageWindow.doGridCz?.('ok')
        } catch {
          selectionFailed = true
          hideStaleReferenceDialog('dlgGridCzDiv', 'grid')
          return true
        }
      }
      return false
    }, 15000)
    if (resolved && !selectionFailed) return true
    cancelReferenceDialog('dlgGridCzDiv', 'grid', pageWindow.doGridCz)
    return false
  }

  let supplierResolved = payload.supplierName === null
  if (payload.supplierName && await resolveHeadReference('DWMC', payload.supplierName, 'DWBH')) {
    supplierResolved = true
    filledHeaderFields += 1
  }
  if (payload.carrierName && await resolveHeadReference('CYDW', payload.carrierName)) {
    filledHeaderFields += 1
  }
  if (payload.transportMethod && await resolveHeadReference('CYFS', payload.transportMethod)) {
    filledHeaderFields += 1
  }
  for (const [fieldId, value] of Object.entries(payload.header)) {
    if (setElementValue(fieldId, value)) filledHeaderFields += 1
  }

  const grid = pageWindow.gridEditBody
  if (!grid) {
    skippedFields.push('采购商品明细表（ERP 网格尚未就绪）')
    return { filledHeaderFields, filledDetailRows, skippedFields }
  }
  if (!supplierResolved) {
    skippedFields.push('采购商品明细（供应商尚未通过 ERP 参照匹配）')
    return { filledHeaderFields, filledDetailRows, skippedFields }
  }
  while (grid.getRows().length < payload.items.length) {
    const addGridRow = pageWindow.gridhandler
    if (!addGridRow) {
      skippedFields.push('采购商品明细表（无法新增行）')
      break
    }
    const expectedCount = grid.getRows().length + 1
    addGridRow.call(pageWindow, 'add', 'B')
    if (!(await waitForRowCount(expectedCount))) {
      skippedFields.push(`采购商品第 ${expectedCount} 行（新增超时）`)
      break
    }
  }

  const usedRowIndexes = new Set<number>()
  for (const item of payload.items) {
    let rows = grid.getRows()
    const rowMatchesItem = (row: GridRow): boolean => {
      const cells = row.cells()
      if (normalize(cellValue(cells.SPMC)) !== normalize(item.productName)) return false
      const checks: Array<[string | null, GridCell | undefined]> = [
        [item.specification, cells.GG],
        [item.manufacturer, cells.SCCS]
      ]
      return checks.every(([expected, cell]) => {
        const expectedValue = normalize(expected)
        const actualValue = normalize(cellValue(cell))
        return !expectedValue || !actualValue ||
          actualValue.includes(expectedValue) || expectedValue.includes(actualValue)
      })
    }
    let rowIndex = rows.findIndex((row, index) =>
      !usedRowIndexes.has(index) && rowMatchesItem(row)
    )
    if (rowIndex < 0) {
      rowIndex = rows.findIndex((row, index) =>
        !usedRowIndexes.has(index) && normalize(cellValue(row.cells().SPMC)) === ''
      )
    }
    if (rowIndex < 0 && pageWindow.gridhandler) {
      const expectedCount = rows.length + 1
      pageWindow.gridhandler.call(pageWindow, 'add', 'B')
      if (await waitForRowCount(expectedCount)) {
        rows = grid.getRows()
        rowIndex = rows.length - 1
      }
    }
    if (rowIndex < 0 || !grid.getRows()[rowIndex]) {
      skippedFields.push(`商品“${item.productName}”（无可用明细行）`)
      continue
    }
    usedRowIndexes.add(rowIndex)
    const existingCells = grid.getRows()[rowIndex].cells()
    const alreadyResolved = rowMatchesItem(grid.getRows()[rowIndex]) &&
      Boolean(normalize(cellValue(existingCells.SPBH)) || normalize(cellValue(existingCells.GG)) || normalize(cellValue(existingCells.SCCS)))
    if (!alreadyResolved && !(await resolveProductReference(rowIndex, item))) {
      skippedFields.push(
        `商品“${item.productName}”（ERP 参照未唯一匹配，请根据规格和厂家手动选择）`
      )
      continue
    }
    if (item.quantity === null || item.quantity <= 0) {
      skippedFields.push(`商品“${item.productName}”.SL（数量无效）`)
      continue
    }
    if (item.taxIncludedUnitPrice === null || item.taxIncludedUnitPrice <= 0) {
      skippedFields.push(`商品“${item.productName}”.DJ（含税单价无效）`)
      continue
    }
    const quantityFilled = await triggerCellEdit(rowIndex, 'SL', String(item.quantity))
    const priceFilled = await triggerCellEdit(rowIndex, 'DJ', String(item.taxIncludedUnitPrice))
    if (!quantityFilled) skippedFields.push(`商品“${item.productName}”.SL`)
    if (!priceFilled) skippedFields.push(`商品“${item.productName}”.DJ`)
    if (!quantityFilled || !priceFilled) continue

    if (item.taxIncludedAmount !== null) {
      const amountUpdated = await waitUntil(() => {
        const amount = Number(cellValue(grid.getRows()[rowIndex]?.cells().JE))
        return Number.isFinite(amount) && Math.abs(amount - item.taxIncludedAmount!) <= 0.02
      }, 8000)
      if (!amountUpdated) {
        skippedFields.push(`商品“${item.productName}”（ERP 含税金额未与票据金额一致）`)
      }
    }
    filledDetailRows += 1
  }

  return { filledHeaderFields, filledDetailRows, skippedFields }
}

export function buildFixtureAutofillScript(businessId: BusinessId): string {
  if (businessId === 'purchase-order') {
    return `(${runPurchaseOrderAutofill.toString()})(${JSON.stringify(buildPurchaseOrderFixturePayload())})`
  }
  if (businessId === 'goods-receipt') {
    return `(${runGoodsReceiptAutofill.toString()})(${JSON.stringify(buildGoodsReceiptFixturePayload())})`
  }
  return `(${runUnitInitialApprovalAutofill.toString()})(${JSON.stringify(buildUnitInitialApprovalFixturePayload())})`
}

export function buildExtractedAutofillScript(extraction: BusinessExtraction): string {
  if (extraction.documentType === 'purchase-order') {
    const payload = buildPurchaseOrderPayload(extraction.header, extraction.items)
    return `(${runPurchaseOrderAutofill.toString()})(${JSON.stringify(payload)})`
  }
  if (extraction.documentType === 'goods-receipt') {
    const payload = buildGoodsReceiptPayload(extraction.header, extraction.items)
    return `(${runGoodsReceiptAutofill.toString()})(${JSON.stringify(payload)})`
  }
  const payload = buildAutofillPayload(extraction.header, extraction.qualificationRows)
  return `(${runUnitInitialApprovalAutofill.toString()})(${JSON.stringify(payload)})`
}

export function createAutofillFailure(
  status: Extract<ErpAutofillResult['status'], 'wrong-page' | 'unavailable' | 'failed'>,
  message: string
): ErpAutofillResult {
  return {
    status,
    message,
    filledHeaderFields: 0,
    filledDetailRows: 0,
    skippedFields: []
  }
}
