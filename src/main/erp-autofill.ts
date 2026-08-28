import mockFixture from '../../test-data/unit-initial-approval.example.json'
import type { ErpAutofillResult } from '../shared/erp'
import type { UnitInitialApprovalExtraction, UnitInitialApprovalHeader } from '../shared/ocr'

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
  setValue: (value: string) => void
}

interface GridRow {
  cells: () => Record<string, GridCell | undefined>
}

interface GridController {
  getRows: () => GridRow[]
}

interface ErpPageWindow extends Window {
  gridEditBody?: GridController
  gridhandler?: (operation: string, gridBit: string) => void
}

interface PageAutofillResult {
  filledHeaderFields: number
  filledQualificationRows: number
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

function buildMockPayload(): AutofillPayload {
  const header = {
    ...mockFixture.erpPayload.header,
    businessScope: mockFixture.rawExtractedData.drugBusinessLicense.businessScope
  } as unknown as UnitInitialApprovalHeader
  return buildAutofillPayload(
    header,
    mockFixture.erpPayload.qualificationRows as QualificationRow[]
  )
}

async function runAutofillInErpPage(payload: AutofillPayload): Promise<PageAutofillResult> {
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
    return { filledHeaderFields, filledQualificationRows: 0, skippedFields }
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

  let filledQualificationRows = 0
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
      filledQualificationRows += 1
    }
  }

  return { filledHeaderFields, filledQualificationRows, skippedFields }
}

export function getMockAutofillPayload(): AutofillPayload {
  return buildMockPayload()
}

export function buildMockAutofillScript(): string {
  return `(${runAutofillInErpPage.toString()})(${JSON.stringify(buildMockPayload())})`
}

export function buildExtractedAutofillScript(
  extraction: UnitInitialApprovalExtraction
): string {
  const payload = buildAutofillPayload(extraction.header, extraction.qualificationRows)
  return `(${runAutofillInErpPage.toString()})(${JSON.stringify(payload)})`
}

export function createAutofillFailure(
  status: Extract<ErpAutofillResult['status'], 'wrong-page' | 'unavailable' | 'failed'>,
  message: string
): ErpAutofillResult {
  return {
    status,
    message,
    filledHeaderFields: 0,
    filledQualificationRows: 0,
    skippedFields: []
  }
}
