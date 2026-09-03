import { Type, type Static } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  ExtractionEvidence,
  PurchaseOrderExtraction,
  PurchaseOrderHeader,
  PurchaseOrderItem
} from '../../shared/business'

const NullableString = Type.Union([Type.String(), Type.Null()])
const NullableNumber = Type.Union([Type.Number(), Type.Null()])

const HeaderSchema = Type.Object(
  {
    supplierName: NullableString,
    sourceOrderNumber: NullableString,
    invoiceDate: NullableString,
    departureDate: NullableString,
    customerName: NullableString,
    receivingAddress: NullableString,
    carrierName: NullableString,
    transportMethod: NullableString,
    coldChain: NullableString,
    transportTimeLimit: NullableNumber,
    receiptRemark: NullableString,
    remark: NullableString,
    paymentMethod: NullableString,
    groupName: NullableString
  },
  { additionalProperties: false }
)

const SourceItemSchema = Type.Object(
  {
    productName: Type.String(),
    specification: NullableString,
    dosageForm: NullableString,
    manufacturer: NullableString,
    origin: NullableString,
    approvalNumber: NullableString,
    marketingAuthorizationHolder: NullableString,
    unit: NullableString,
    packageQuantity: NullableNumber,
    batchNumber: NullableString,
    quantity: NullableNumber,
    taxIncludedUnitPrice: NullableNumber,
    taxIncludedAmount: NullableNumber,
    productionDate: NullableString,
    expiryDate: NullableString,
    qualityStatus: NullableString,
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

export const PurchaseOrderSubmissionSchema = Type.Object(
  {
    header: HeaderSchema,
    items: Type.Array(SourceItemSchema),
    evidence: Type.Array(EvidenceSchema),
    reviewRequired: Type.Array(Type.String())
  },
  { additionalProperties: false }
)

export type PurchaseOrderSubmission = Static<typeof PurchaseOrderSubmissionSchema>

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizedDate(value: unknown): string | null {
  const text = nullableText(value)
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const date = new Date(`${text}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function uniquePages(values: readonly number[], pageCount: number): number[] {
  return [...new Set(values.filter(
    (value) => Number.isInteger(value) && value >= 1 && value <= pageCount
  ))].sort((left, right) => left - right)
}

function roundedMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

function normalizedHeader(
  submission: PurchaseOrderSubmission,
  review: string[]
): PurchaseOrderHeader {
  const rawPaymentMethod = nullableText(submission.header.paymentMethod)
  const paymentMethod = rawPaymentMethod === '款到发货' || rawPaymentMethod === '货到付款'
    ? rawPaymentMethod
    : null
  if (rawPaymentMethod && !paymentMethod) {
    review.push(`付款方式“${rawPaymentMethod}”不在 ERP 选项中，请手动选择`)
  }

  const rawColdChain = nullableText(submission.header.coldChain)
  const coldChain = rawColdChain?.includes('是')
    ? '是'
    : rawColdChain?.includes('否')
      ? '否'
      : null

  return {
    supplierName: nullableText(submission.header.supplierName),
    sourceOrderNumber: nullableText(submission.header.sourceOrderNumber)?.replace(/\s+/g, '') ?? null,
    invoiceDate: normalizedDate(submission.header.invoiceDate),
    departureDate: normalizedDate(submission.header.departureDate),
    customerName: nullableText(submission.header.customerName),
    receivingAddress: nullableText(submission.header.receivingAddress),
    carrierName: nullableText(submission.header.carrierName),
    transportMethod: nullableText(submission.header.transportMethod),
    coldChain,
    transportTimeLimit: nullableNumber(submission.header.transportTimeLimit),
    receiptRemark: nullableText(submission.header.receiptRemark),
    remark: nullableText(submission.header.remark),
    paymentMethod,
    groupName: nullableText(submission.header.groupName)
  }
}

function normalizedItems(
  submission: PurchaseOrderSubmission,
  pageCount: number,
  review: string[]
): PurchaseOrderItem[] {
  const rows = submission.items.flatMap((item, index): PurchaseOrderItem[] => {
    const productName = item.productName.trim()
    if (!productName) return []

    const quantity = nullableNumber(item.quantity)
    const unitPrice = nullableNumber(item.taxIncludedUnitPrice)
    let amount = nullableNumber(item.taxIncludedAmount)
    if (quantity !== null && quantity <= 0) review.push(`第 ${index + 1} 条商品数量必须大于零`)
    if (unitPrice !== null && unitPrice <= 0) review.push(`第 ${index + 1} 条商品含税单价必须大于零`)

    if (quantity !== null && unitPrice !== null) {
      const calculated = roundedMoney(quantity * unitPrice)
      if (amount === null) amount = calculated
      else if (Math.abs(amount - calculated) > 0.02) {
        review.push(
          `第 ${index + 1} 条商品金额 ${amount} 与数量×单价 ${calculated} 不一致`
        )
      }
    }

    const productionDate = normalizedDate(item.productionDate)
    const expiryDate = normalizedDate(item.expiryDate)
    if (item.productionDate && !productionDate) review.push(`第 ${index + 1} 条生产日期格式无效`)
    if (item.expiryDate && !expiryDate) review.push(`第 ${index + 1} 条有效期格式无效`)

    return [{
      productName,
      specification: nullableText(item.specification),
      dosageForm: nullableText(item.dosageForm),
      manufacturer: nullableText(item.manufacturer),
      origin: nullableText(item.origin),
      approvalNumber: nullableText(item.approvalNumber)?.replace(/\s+/g, '') ?? null,
      marketingAuthorizationHolder: nullableText(item.marketingAuthorizationHolder),
      unit: nullableText(item.unit),
      packageQuantity: nullableNumber(item.packageQuantity),
      quantity,
      taxIncludedUnitPrice: unitPrice,
      taxIncludedAmount: amount,
      batchNumber: nullableText(item.batchNumber)?.replace(/\s+/g, '') ?? null,
      productionDate,
      expiryDate,
      qualityStatus: nullableText(item.qualityStatus),
      sourcePages: uniquePages(item.sourcePages, pageCount)
    }]
  })
  return rows
}

function normalizedEvidence(
  submission: PurchaseOrderSubmission,
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

export function normalizePurchaseOrderSubmission(
  submission: PurchaseOrderSubmission,
  pageCount: number
): PurchaseOrderExtraction {
  const review = uniqueStrings([
    '保存前必须由采购人员核对供应商、商品、数量、单价和付款方式',
    ...submission.reviewRequired
  ])
  const header = normalizedHeader(submission, review)
  const items = normalizedItems(submission, pageCount, review)
  const fieldEvidence = normalizedEvidence(submission, pageCount)

  if (!header.supplierName) review.push('未识别到销售方/供应商名称')
  if (!header.departureDate) review.push('未识别到发货日期，ERP 将保留当天默认日期')
  if (!header.paymentMethod) review.push('票据无法确定付款方式，请在 ERP 中手动选择')
  if (items.length === 0) review.push('未识别到可用的采购商品明细')
  items.forEach((item, index) => {
    if (item.quantity === null || item.quantity <= 0) review.push(`第 ${index + 1} 条采购商品缺少有效数量`)
    if (item.taxIncludedUnitPrice === null || item.taxIncludedUnitPrice <= 0) {
      review.push(`第 ${index + 1} 条采购商品缺少有效含税单价`)
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
    !header.paymentMethod ? '付款方式（需人工选择）' : null,
    items.length === 0 ? '采购商品明细' : null
  ].filter((value): value is string => value !== null)

  return {
    documentType: 'purchase-order',
    header,
    items,
    fieldEvidence,
    recognizedFieldCount: recognizedHeaderCount + recognizedItemCount,
    missingRecommendedFields,
    reviewRequired: uniqueStrings(review),
    readyForAutofill: Boolean(
      header.supplierName &&
        items.length > 0 &&
        items.every((item) =>
          item.quantity !== null && item.quantity > 0 &&
          item.taxIncludedUnitPrice !== null && item.taxIncludedUnitPrice > 0
        )
    )
  }
}

export function mergePurchaseOrderExtractions(
  current: PurchaseOrderExtraction | null,
  incoming: PurchaseOrderExtraction
): PurchaseOrderExtraction {
  if (!current) return incoming

  const header = { ...current.header }
  const review = [...current.reviewRequired, ...incoming.reviewRequired]
  const fieldEvidence = { ...current.fieldEvidence }
  for (const key of Object.keys(incoming.header) as Array<keyof PurchaseOrderHeader>) {
    const incomingValue = incoming.header[key]
    if (incomingValue === null || incomingValue === '') continue
    const currentValue = header[key]
    const incomingEvidence = incoming.fieldEvidence[`header.${String(key)}`]
    const currentEvidence = current.fieldEvidence[`header.${String(key)}`]
    if (currentValue === null || currentValue === '') {
      Object.assign(header, { [key]: incomingValue })
    } else if (currentValue !== incomingValue) {
      review.push(`${String(key)} 在不同页面出现不同值，已保留置信度较高的结果`)
      if ((incomingEvidence?.confidence ?? 0) > (currentEvidence?.confidence ?? 0)) {
        Object.assign(header, { [key]: incomingValue })
      }
    }
    if (incomingEvidence && (!currentEvidence || incomingEvidence.confidence > currentEvidence.confidence)) {
      fieldEvidence[`header.${String(key)}`] = incomingEvidence
    }
  }

  const items = [...current.items, ...incoming.items].sort((left, right) => {
    const leftPage = left.sourcePages[0] ?? Number.MAX_SAFE_INTEGER
    const rightPage = right.sourcePages[0] ?? Number.MAX_SAFE_INTEGER
    return leftPage - rightPage
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
  const missingRecommendedFields = uniqueStrings([
    ...current.missingRecommendedFields,
    ...incoming.missingRecommendedFields
  ]).filter((field) => {
    if (field === '供应商名称') return !header.supplierName
    if (field === '启运日期') return !header.departureDate
    if (field === '采购商品明细') return items.length === 0
    return true
  })

  return {
    documentType: 'purchase-order',
    header,
    items,
    fieldEvidence: { ...fieldEvidence, ...incoming.fieldEvidence },
    recognizedFieldCount: recognizedHeaderCount + recognizedItemCount,
    missingRecommendedFields,
    reviewRequired: uniqueStrings(review),
    readyForAutofill: Boolean(
      header.supplierName &&
        items.length > 0 &&
        items.every((item) =>
          item.quantity !== null && item.quantity > 0 &&
          item.taxIncludedUnitPrice !== null && item.taxIncludedUnitPrice > 0
        )
    )
  }
}

export function calculatePurchaseOrderCoverage(extraction: PurchaseOrderExtraction): number {
  const checks = [
    Boolean(extraction.header.supplierName),
    Boolean(extraction.header.departureDate),
    Boolean(extraction.header.sourceOrderNumber),
    extraction.items.length > 0,
    extraction.items.length > 0 && extraction.items.every((item) => item.quantity !== null),
    extraction.items.length > 0 && extraction.items.every((item) => item.taxIncludedUnitPrice !== null),
    Boolean(extraction.header.paymentMethod)
  ]
  return Math.round((checks.filter(Boolean).length / checks.length) * 100)
}

export function purchaseOrderSystemPrompt(): string {
  return `你是采购订单来源票据的字段标准化代理。
要求：
1. supplierName 必须是票据的销售方、供货方或出库方，不能填客户名称或收货单位。
2. 只提取原文明确出现的内容；缺失字符串填 null，缺失数字填 null，缺失数组填 []。
3. 日期统一为 YYYY-MM-DD。发货日期对应 departureDate，开票日期对应 invoiceDate。
4. 票据表格每一个印刷行都必须生成且仅生成一条 items。即使商品、规格、厂家、批准文号、单位、批号和单价都相同，也严禁合并、求和或去重，并保持票据原始行顺序。
5. 每行保留商品名称、规格、剂型、生产企业、产地、批准文号、上市许可持有人、单位、装量、批号、数量、含税单价、含税金额、生产日期和有效期。
6. 付款方式只能在原文明确表述“款到发货”或“货到付款”时填写，否则填 null。
7. 冷链商品只在原文明确说明时填“是”或“否”，否则填 null。
8. 物流储运委托第三方可作为 carrierName；不得猜测 transportMethod。
9. sourcePages 使用 1 开始的真实页码；evidence.fieldPath 使用 header.supplierName 或 items[0].quantity 格式。
10. 印章遮挡、文字模糊、金额不平或无法确定字段时写入 reviewRequired。
11. 完成后必须且只能调用 submit_purchase_order 一次，不输出普通文本。`
}

export function createPurchaseOrderSubmissionTool(
  submit: (submission: PurchaseOrderSubmission) => void
): AgentTool<typeof PurchaseOrderSubmissionSchema, { accepted: true }> {
  return {
    name: 'submit_purchase_order',
    label: '提交采购订单字段',
    description: '提交从供应商销售出库单中提取并标准化后的采购订单字段。',
    parameters: PurchaseOrderSubmissionSchema,
    async execute(_toolCallId, params) {
      submit(params)
      return {
        content: [{ type: 'text', text: '采购订单字段已接收，等待程序规则校验。' }],
        details: { accepted: true },
        terminate: true
      }
    }
  }
}
