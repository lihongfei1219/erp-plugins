import { Type, type Static } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  ExtractionEvidence,
  GoodsReceiptExtraction,
  GoodsReceiptHeader,
  GoodsReceiptItem
} from '../../shared/business'

const NullableString = Type.Union([Type.String(), Type.Null()])
const NullableNumber = Type.Union([Type.Number(), Type.Null()])

const HeaderSchema = Type.Object(
  {
    supplierName: NullableString,
    departureDate: NullableString,
    carrierName: NullableString,
    transportMethod: NullableString,
    receiptDateTime: NullableString,
    surfaceTemperature: NullableNumber,
    transportProcessTemperatureStatus: NullableString,
    transportVehicle: NullableString,
    departurePlace: NullableString,
    departureDateTime: NullableString,
    receiptDateTimeDetail: NullableString,
    actualTransportHours: NullableNumber,
    receiptRemark: NullableString,
    goodsAccountConsistency: NullableString,
    deliveryNoteCompliance: NullableString,
    enclosedVehicle: NullableString,
    logisticsVoucherCompliance: NullableString,
    transportTimeLimitStatus: NullableString
  },
  { additionalProperties: false }
)

const ItemSchema = Type.Object(
  {
    productName: Type.String(),
    specification: NullableString,
    manufacturer: NullableString,
    marketingAuthorizationHolder: NullableString,
    unit: NullableString,
    packageQuantity: NullableNumber,
    arrivalQuantity: NullableNumber,
    receiptQuantity: NullableNumber,
    unitPrice: NullableNumber,
    amount: NullableNumber,
    batchNumber: NullableString,
    productionDate: NullableString,
    expiryDate: NullableString,
    approvalNumber: NullableString,
    dosageForm: NullableString,
    pieceRatio: NullableNumber,
    remark: NullableString,
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

export const GoodsReceiptSubmissionSchema = Type.Object(
  {
    header: HeaderSchema,
    items: Type.Array(ItemSchema),
    evidence: Type.Array(EvidenceSchema),
    reviewRequired: Type.Array(Type.String())
  },
  { additionalProperties: false }
)

export type GoodsReceiptSubmission = Static<typeof GoodsReceiptSubmissionSchema>

const MANUAL_DECISION_FIELDS: Array<keyof GoodsReceiptHeader> = [
  'goodsAccountConsistency',
  'deliveryNoteCompliance',
  'enclosedVehicle',
  'logisticsVoucherCompliance',
  'transportProcessTemperatureStatus',
  'transportTimeLimitStatus'
]

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

function normalizedDateTime(value: unknown): string | null {
  const text = nullableText(value)
  if (!text) return null
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(text)
    ? text.replace('T', ' ')
    : null
}

function normalizedHeader(submission: GoodsReceiptSubmission): GoodsReceiptHeader {
  const header: GoodsReceiptHeader = {
    supplierName: nullableText(submission.header.supplierName),
    departureDate: normalizedDate(submission.header.departureDate),
    carrierName: nullableText(submission.header.carrierName),
    transportMethod: nullableText(submission.header.transportMethod),
    receiptDateTime: normalizedDateTime(submission.header.receiptDateTime),
    surfaceTemperature: nullableNumber(submission.header.surfaceTemperature),
    transportProcessTemperatureStatus: nullableText(submission.header.transportProcessTemperatureStatus),
    transportVehicle: nullableText(submission.header.transportVehicle),
    departurePlace: nullableText(submission.header.departurePlace),
    departureDateTime: normalizedDateTime(submission.header.departureDateTime),
    receiptDateTimeDetail: normalizedDateTime(submission.header.receiptDateTimeDetail),
    actualTransportHours: nullableNumber(submission.header.actualTransportHours),
    receiptRemark: nullableText(submission.header.receiptRemark),
    goodsAccountConsistency: nullableText(submission.header.goodsAccountConsistency),
    deliveryNoteCompliance: nullableText(submission.header.deliveryNoteCompliance),
    enclosedVehicle: nullableText(submission.header.enclosedVehicle),
    logisticsVoucherCompliance: nullableText(submission.header.logisticsVoucherCompliance),
    transportTimeLimitStatus: nullableText(submission.header.transportTimeLimitStatus)
  }

  for (const key of MANUAL_DECISION_FIELDS) header[key] = null
  return header
}

function normalizedItems(
  submission: GoodsReceiptSubmission,
  pageCount: number,
  review: string[]
): GoodsReceiptItem[] {
  return submission.items
    .map((item, index): GoodsReceiptItem | null => {
      const productionDate = normalizedDate(item.productionDate)
      const expiryDate = normalizedDate(item.expiryDate)
      if (item.productionDate && !productionDate) review.push(`第 ${index + 1} 条商品生产日期格式无效`)
      if (item.expiryDate && !expiryDate) review.push(`第 ${index + 1} 条商品有效期格式无效`)

      const normalized: GoodsReceiptItem = {
        productName: item.productName.trim(),
        specification: nullableText(item.specification),
        manufacturer: nullableText(item.manufacturer),
        marketingAuthorizationHolder: nullableText(item.marketingAuthorizationHolder),
        unit: nullableText(item.unit),
        packageQuantity: nullableNumber(item.packageQuantity),
        arrivalQuantity: nullableNumber(item.arrivalQuantity),
        receiptQuantity: nullableNumber(item.receiptQuantity),
        unitPrice: nullableNumber(item.unitPrice),
        amount: nullableNumber(item.amount),
        batchNumber: nullableText(item.batchNumber)?.replace(/\s+/g, '') ?? null,
        productionDate,
        expiryDate,
        approvalNumber: nullableText(item.approvalNumber)?.replace(/\s+/g, '') ?? null,
        dosageForm: nullableText(item.dosageForm),
        pieceRatio: nullableNumber(item.pieceRatio),
        remark: nullableText(item.remark),
        sourcePages: uniquePages(item.sourcePages, pageCount)
      }
      return normalized.productName ? normalized : null
    })
    .filter((item): item is GoodsReceiptItem => item !== null)
}

function normalizedEvidence(
  submission: GoodsReceiptSubmission,
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

function itemKey(item: GoodsReceiptItem): string {
  return [item.approvalNumber, item.batchNumber, item.productName, item.specification]
    .map((value) => value ?? '')
    .join('\u0000')
}

export function normalizeGoodsReceiptSubmission(
  submission: GoodsReceiptSubmission,
  pageCount: number
): GoodsReceiptExtraction {
  const review = uniqueStrings([
    '识别结果必须在 ERP 保存前由收货人员对照随货同行单核验',
    ...submission.reviewRequired
  ])
  const header = normalizedHeader(submission)
  const items = normalizedItems(submission, pageCount, review)
  const fieldEvidence = normalizedEvidence(submission, pageCount)

  if (!header.supplierName) review.push('未识别到销售方或供应商名称')
  if (items.length === 0) review.push('未识别到可用商品明细')
  items.forEach((item, index) => {
    if (item.arrivalQuantity === null && item.receiptQuantity === null) {
      review.push(`第 ${index + 1} 条商品缺少到货或收货数量`)
    }
  })

  const recognizedHeaderCount = Object.values(header).filter(
    (value) => value !== null && value !== ''
  ).length
  const recognizedItemCount = items.reduce(
    (total, item) => total + Object.values(item).filter(
      (value) => value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
    ).length,
    0
  )

  const missingRecommendedFields = [
    !header.supplierName ? '供应商名称' : null,
    !header.departureDate ? '启运日期' : null,
    items.length === 0 ? '商品明细' : null
  ].filter((value): value is string => value !== null)

  return {
    documentType: 'goods-receipt',
    header,
    items,
    fieldEvidence,
    recognizedFieldCount: recognizedHeaderCount + recognizedItemCount,
    missingRecommendedFields,
    reviewRequired: uniqueStrings(review),
    readyForAutofill: Boolean(
      header.supplierName &&
        items.length > 0 &&
        items.every((item) => item.arrivalQuantity !== null || item.receiptQuantity !== null)
    )
  }
}

export function mergeGoodsReceiptExtractions(
  current: GoodsReceiptExtraction | null,
  incoming: GoodsReceiptExtraction,
  pageCount: number
): GoodsReceiptExtraction {
  if (!current) return incoming

  const mergedHeader = { ...current.header }
  const review = [...current.reviewRequired, ...incoming.reviewRequired]
  const fieldEvidence = { ...current.fieldEvidence }

  for (const key of Object.keys(incoming.header) as Array<keyof GoodsReceiptHeader>) {
    const incomingValue = incoming.header[key]
    if (incomingValue === null || incomingValue === '') continue
    const currentValue = mergedHeader[key]
    const incomingEvidence = incoming.fieldEvidence[`header.${String(key)}`]
    const currentEvidence = current.fieldEvidence[`header.${String(key)}`]
    if (currentValue === null || currentValue === '') {
      Object.assign(mergedHeader, { [key]: incomingValue })
    } else if (currentValue !== incomingValue) {
      review.push(`${String(key)} 在不同页面识别到不同值，已保留置信度较高的结果`)
      if ((incomingEvidence?.confidence ?? 0) > (currentEvidence?.confidence ?? 0)) {
        Object.assign(mergedHeader, { [key]: incomingValue })
      }
    }
    if (incomingEvidence && (!currentEvidence || incomingEvidence.confidence > currentEvidence.confidence)) {
      fieldEvidence[`header.${String(key)}`] = incomingEvidence
    }
  }

  const items = current.items.map((item) => ({ ...item, sourcePages: [...item.sourcePages] }))
  const indexes = new Map(items.map((item, index) => [itemKey(item), index]))
  for (const item of incoming.items) {
    const key = itemKey(item)
    const index = indexes.get(key)
    if (index === undefined) {
      indexes.set(key, items.length)
      items.push({ ...item, sourcePages: [...item.sourcePages] })
    } else {
      items[index] = {
        ...items[index],
        ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null && value !== '')),
        sourcePages: [...new Set([...items[index].sourcePages, ...item.sourcePages])].sort(
          (left, right) => left - right
        )
      } as GoodsReceiptItem
    }
  }

  const submission: GoodsReceiptSubmission = {
    header: mergedHeader,
    items,
    evidence: Object.entries({ ...fieldEvidence, ...incoming.fieldEvidence }).map(
      ([fieldPath, evidence]) => ({ fieldPath, ...evidence })
    ),
    reviewRequired: uniqueStrings(review)
  }
  return normalizeGoodsReceiptSubmission(submission, pageCount)
}

export function calculateGoodsReceiptCoverage(extraction: GoodsReceiptExtraction): number {
  const checks = [
    Boolean(extraction.header.supplierName),
    Boolean(extraction.header.departureDate),
    extraction.items.length > 0,
    extraction.items.length > 0 && extraction.items.every((item) => Boolean(item.productName)),
    extraction.items.length > 0 && extraction.items.every(
      (item) => item.arrivalQuantity !== null || item.receiptQuantity !== null
    )
  ]
  return Math.round((checks.filter(Boolean).length / checks.length) * 100)
}

export function goodsReceiptSystemPrompt(): string {
  return `你是商品收货随货同行单的字段标准化代理。

要求：
1. 区分销售方/供货方与收货单位，supplierName 必须填写销售方或供货方，不能填写收货单位。
2. 只提取原文明确出现的内容，不得猜测。缺失字符串填 null，缺失数字填 null，缺失数组填 []。
3. 日期统一为 YYYY-MM-DD，日期时间统一为 YYYY-MM-DD HH:mm:ss 或 YYYY-MM-DD HH:mm。
4. 每个商品生成一条 items，保留商品名、规格、生产企业、上市许可持有人、单位、数量、单价、金额、批号、生产日期、有效期、批准文号和剂型。
5. goodsAccountConsistency、deliveryNoteCompliance、enclosedVehicle、logisticsVoucherCompliance、transportProcessTemperatureStatus、transportTimeLimitStatus 是现场判断项，一律填 null。
6. 销售日期不能当作实际收货日期；票据没有收货时间时 receiptDateTime 和 receiptDateTimeDetail 填 null。
7. sourcePages 使用 1 开始的真实页码。evidence.fieldPath 使用 header.supplierName 或 items[0].batchNumber 形式。
8. 遮挡、文字模糊、数量金额不一致、同商品多批号等情况写入 reviewRequired。
9. 完成后必须且只能调用 submit_goods_receipt 一次，不输出普通文本。`
}

export function createGoodsReceiptSubmissionTool(
  submit: (submission: GoodsReceiptSubmission) => void
): AgentTool<typeof GoodsReceiptSubmissionSchema, { accepted: true }> {
  return {
    name: 'submit_goods_receipt',
    label: '提交商品收货字段',
    description: '提交从随货同行单中提取并标准化后的商品收货字段。',
    parameters: GoodsReceiptSubmissionSchema,
    async execute(_toolCallId, params) {
      submit(params)
      return {
        content: [{ type: 'text', text: '商品收货字段已接收，等待程序规则校验。' }],
        details: { accepted: true },
        terminate: true
      }
    }
  }
}
