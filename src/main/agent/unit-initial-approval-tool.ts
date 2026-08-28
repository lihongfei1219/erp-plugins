import { Type, type Static } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import fieldConfiguration from '../../../config/erp/unit-initial-approval.fields.json'
import type {
  ExtractionEvidence,
  QualificationRow,
  UnitInitialApprovalExtraction,
  UnitInitialApprovalHeader
} from '../../shared/ocr'

const NullableString = Type.Union([Type.String(), Type.Null()])
const HeaderSchema = Type.Object(
  {
    referenceYaoshibang: NullableString,
    referenceYaobang: NullableString,
    unitCode: NullableString,
    exists: Type.Union([Type.String(), Type.Boolean(), Type.Null()]),
    buyerName: NullableString,
    businessDivision: NullableString,
    unitName: NullableString,
    buyerIdCardNo: NullableString,
    companyBankName: NullableString,
    unitShortName: NullableString,
    legalRepresentative: NullableString,
    companyTaxNo: NullableString,
    businessLicenseNo: NullableString,
    companyInvoiceType: NullableString,
    selfPickupName: NullableString,
    registeredAddress: NullableString,
    companyAccountName: NullableString,
    selfPickupIdCardNo: NullableString,
    warehouseAddress: NullableString,
    companyBankAccount: NullableString,
    siteInspectionStatus: NullableString,
    unitPhone: NullableString,
    invoiceContactPhone: NullableString,
    qualityResponsiblePerson: NullableString,
    unitType: NullableString,
    enterpriseResponsiblePerson: NullableString,
    receivingPerson: NullableString,
    receivingPhone: NullableString,
    receivingAddress: NullableString,
    earliestQualificationExpiryDate: NullableString,
    qualificationExpiryReminder: NullableString,
    businessScope: Type.Array(Type.String())
  },
  { additionalProperties: false }
)

const QualificationSchema = Type.Object(
  {
    dataType: Type.String(),
    certificateNo: NullableString,
    issuingAuthority: NullableString,
    issueDate: NullableString,
    expiryDate: NullableString,
    expiryControl: Type.Boolean(),
    materialProvided: Type.Boolean(),
    sourcePages: Type.Array(Type.Integer({ minimum: 1 }))
  },
  { additionalProperties: false }
)

const EvidenceSchema = Type.Object(
  {
    fieldPath: Type.String(),
    sourcePages: Type.Array(Type.Integer({ minimum: 1 })),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    reviewRequired: Type.Boolean()
  },
  { additionalProperties: false }
)

export const UnitInitialApprovalSubmissionSchema = Type.Object(
  {
    header: HeaderSchema,
    qualificationRows: Type.Array(QualificationSchema),
    evidence: Type.Array(EvidenceSchema),
    reviewRequired: Type.Array(Type.String())
  },
  { additionalProperties: false }
)

export type UnitInitialApprovalSubmission = Static<
  typeof UnitInitialApprovalSubmissionSchema
>

const SYSTEM_MANAGED_FIELDS = new Set([
  'referenceYaoshibang',
  'referenceYaobang',
  'unitCode',
  'exists',
  'businessDivision'
])

const STRING_HEADER_FIELDS: Array<
  Exclude<keyof UnitInitialApprovalHeader, 'exists' | 'businessScope'>
> = [
  'referenceYaoshibang',
  'referenceYaobang',
  'unitCode',
  'buyerName',
  'businessDivision',
  'unitName',
  'buyerIdCardNo',
  'companyBankName',
  'unitShortName',
  'legalRepresentative',
  'companyTaxNo',
  'businessLicenseNo',
  'companyInvoiceType',
  'selfPickupName',
  'registeredAddress',
  'companyAccountName',
  'selfPickupIdCardNo',
  'warehouseAddress',
  'companyBankAccount',
  'siteInspectionStatus',
  'unitPhone',
  'invoiceContactPhone',
  'qualityResponsiblePerson',
  'unitType',
  'enterpriseResponsiblePerson',
  'receivingPerson',
  'receivingPhone',
  'receivingAddress',
  'earliestQualificationExpiryDate',
  'qualificationExpiryReminder'
]

interface HeaderFieldDefinition {
  key: string
  label: string
  requiredForExtraction: boolean
  source: string
  valueType: string
  ocrHints?: string[]
}

interface QualificationFieldDefinition {
  key: string
  label: string
  requiredForExtraction: boolean
  valueType: string
  examples?: string[]
  ocrHints?: string[]
}

const headerFieldDefinitions = fieldConfiguration.headerFields as HeaderFieldDefinition[]
const qualificationFieldDefinitions = fieldConfiguration.qualificationGrid
  .fields as QualificationFieldDefinition[]

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function uniquePages(values: readonly number[], pageCount: number): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 1 && value <= pageCount))]
    .sort((left, right) => left - right)
}

function normalizedDate(value: unknown): string | null {
  const text = nullableText(value)
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const date = new Date(`${text}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text
}

function normalizedHeader(submission: UnitInitialApprovalSubmission): UnitInitialApprovalHeader {
  const header = {
    ...submission.header,
    businessScope: uniqueStrings(submission.header.businessScope)
  } as UnitInitialApprovalHeader

  for (const field of STRING_HEADER_FIELDS) {
    header[field] = nullableText(submission.header[field])
  }
  for (const field of SYSTEM_MANAGED_FIELDS) {
    if (field === 'exists') header.exists = null
    else header[field as Exclude<keyof UnitInitialApprovalHeader, 'exists' | 'businessScope'>] = null
  }
  header.siteInspectionStatus = null
  return header
}

function normalizedQualifications(
  submission: UnitInitialApprovalSubmission,
  pageCount: number,
  review: string[]
): QualificationRow[] {
  const rows = submission.qualificationRows
    .map((row, index): QualificationRow | null => {
      const issueDate = normalizedDate(row.issueDate)
      const expiryDate = normalizedDate(row.expiryDate)
      if (row.issueDate && !issueDate) review.push(`第 ${index + 1} 条资质的发证日期格式无效`)
      if (row.expiryDate && !expiryDate) review.push(`第 ${index + 1} 条资质的到期日期格式无效`)

      const normalized: QualificationRow = {
        dataType: row.dataType.trim(),
        certificateNo: nullableText(row.certificateNo),
        issuingAuthority: nullableText(row.issuingAuthority),
        issueDate,
        expiryDate,
        expiryControl: expiryDate !== null,
        materialProvided: row.materialProvided,
        sourcePages: uniquePages(row.sourcePages, pageCount)
      }
      const hasContent = Boolean(
        normalized.dataType ||
          normalized.certificateNo ||
          normalized.issuingAuthority ||
          normalized.issueDate ||
          normalized.expiryDate
      )
      return hasContent ? normalized : null
    })
    .filter((row): row is QualificationRow => row !== null)

  return rows.filter((row, index) => {
    const firstIndex = rows.findIndex(
      (candidate) =>
        candidate.dataType === row.dataType && candidate.certificateNo === row.certificateNo
    )
    return firstIndex === index
  })
}

function normalizedEvidence(
  submission: UnitInitialApprovalSubmission,
  pageCount: number
): Record<string, ExtractionEvidence> {
  const evidence: Record<string, ExtractionEvidence> = {}
  for (const item of submission.evidence) {
    const fieldPath = item.fieldPath.trim()
    if (!fieldPath) continue
    evidence[fieldPath] = {
      sourcePages: uniquePages(item.sourcePages, pageCount),
      confidence: Math.min(1, Math.max(0, item.confidence)),
      reviewRequired: item.reviewRequired
    }
  }
  return evidence
}

function recognizedHeaderFieldCount(header: UnitInitialApprovalHeader): number {
  const excluded = new Set([
    ...SYSTEM_MANAGED_FIELDS,
    'siteInspectionStatus',
    'earliestQualificationExpiryDate',
    'qualificationExpiryReminder'
  ])
  return Object.entries(header).filter(([key, value]) => {
    if (excluded.has(key)) return false
    return Array.isArray(value) ? value.length > 0 : value !== null && value !== ''
  }).length
}

export function normalizeUnitInitialApprovalSubmission(
  submission: UnitInitialApprovalSubmission,
  pageCount: number
): UnitInitialApprovalExtraction {
  const review = uniqueStrings([
    '模型提取结果必须在 ERP 保存前由用户对照原件核验',
    ...submission.reviewRequired
  ])
  const header = normalizedHeader(submission)
  const qualificationRows = normalizedQualifications(submission, pageCount, review)
  const evidence = normalizedEvidence(submission, pageCount)

  header.businessLicenseNo = header.businessLicenseNo?.replace(/\s+/g, '').toUpperCase() ?? null
  header.companyTaxNo = header.companyTaxNo?.replace(/\s+/g, '').toUpperCase() ?? null
  header.companyBankAccount = header.companyBankAccount?.replace(/\s+/g, '') ?? null
  header.buyerIdCardNo = header.buyerIdCardNo?.replace(/\s+/g, '').toUpperCase() ?? null
  header.selfPickupIdCardNo = header.selfPickupIdCardNo?.replace(/\s+/g, '').toUpperCase() ?? null

  const expiryDates = qualificationRows
    .map((row) => row.expiryDate)
    .filter((value): value is string => value !== null)
    .sort()
  header.earliestQualificationExpiryDate = expiryDates[0] ?? null
  header.qualificationExpiryReminder = qualificationRows.some((row) => row.expiryControl)
    ? '是'
    : '否'

  if (header.companyBankName || header.companyBankAccount) {
    review.push('开户银行和银行账号属于敏感字段，请重点核对')
  }
  if (header.buyerIdCardNo || header.selfPickupIdCardNo) {
    review.push('身份证号码属于敏感字段，请对照证件原图核对')
  }
  if (header.businessLicenseNo && !/^[0-9A-Z]{18}$/.test(header.businessLicenseNo)) {
    review.push('营业执照号不是标准 18 位统一社会信用代码，请核对')
  }
  qualificationRows.forEach((row, index) => {
    if (!row.dataType || !row.certificateNo || !row.issuingAuthority || !row.issueDate) {
      review.push(`第 ${index + 1} 条资质信息不完整`)
    }
  })

  const missingRecommendedFields = headerFieldDefinitions
    .filter((field) => field.requiredForExtraction)
    .filter((field) => {
      const value = header[field.key as keyof UnitInitialApprovalHeader]
      return Array.isArray(value) ? value.length === 0 : value === null || value === ''
    })
    .map((field) => field.label)

  return {
    documentType: 'unit-initial-approval',
    header,
    qualificationRows,
    fieldEvidence: evidence,
    recognizedFieldCount: recognizedHeaderFieldCount(header),
    missingRecommendedFields,
    reviewRequired: uniqueStrings(review),
    readyForAutofill: Boolean(
      header.unitName &&
        header.businessLicenseNo &&
        header.registeredAddress &&
        qualificationRows.length > 0
    )
  }
}

export function unitInitialApprovalSystemPrompt(): string {
  const fieldSummary = headerFieldDefinitions.map((field) => ({
    key: field.key,
    label: field.label,
    required: field.requiredForExtraction,
    source: field.source,
    valueType: field.valueType,
    hints: field.ocrHints ?? []
  }))
  const qualificationSummary = qualificationFieldDefinitions.map((field) => ({
    key: field.key,
    label: field.label,
    required: field.requiredForExtraction,
    valueType: field.valueType,
    examples: field.examples ?? [],
    hints: field.ocrHints ?? []
  }))

  return `你是单位首营审批资料的字段标准化代理。输入可能是单页增量，也可能是按页分隔的 OCR 原文。

工作要求：
1. 交叉比对营业执照、药品/食品/医疗器械许可、授权书、开票资料和合同，提取同一单位的信息。
2. 只能使用原文中明确出现的信息，不猜测、不补造；缺失字符串必须填 null，缺失数组填 []。
3. 日期统一为 YYYY-MM-DD；长期有效或没有明确到期日时 expiryDate 填 null。
4. 系统生成或人工选择字段 referenceYaoshibang、referenceYaobang、unitCode、exists、businessDivision 一律填 null。
5. siteInspectionStatus 属于人工考察结论，一律填 null。
6. 每条证照生成一条 qualificationRows，sourcePages 使用 1 开始的真实页码。
7. evidence.fieldPath 使用 header.unitName 或 qualificationRows[0].certificateNo 这样的路径，并给出来源页、0 到 1 的模型置信度以及是否需复核。
8. 对印章遮挡、多个版本冲突、证件号/日期模糊和敏感信息加入 reviewRequired。
9. 完成后必须且只能调用 submit_unit_initial_approval 一次，不要只输出普通文本。
10. 输入只有单页时只提取该页明确出现的内容，不得用常识补齐其他页面字段。

主表字段定义：${JSON.stringify(fieldSummary)}

资质明细字段定义：${JSON.stringify(qualificationSummary)}`
}

export function createUnitInitialApprovalSubmissionTool(
  submit: (submission: UnitInitialApprovalSubmission) => void
): AgentTool<typeof UnitInitialApprovalSubmissionSchema, { accepted: true }> {
  return {
    name: 'submit_unit_initial_approval',
    label: '提交单位首营审批字段',
    description: '提交从当前 OCR 文档中提取并标准化后的单位首营审批字段。',
    parameters: UnitInitialApprovalSubmissionSchema,
    async execute(_toolCallId, params) {
      submit(params)
      return {
        content: [{ type: 'text', text: '字段已接收，等待程序规则校验。' }],
        details: { accepted: true },
        terminate: true
      }
    }
  }
}
