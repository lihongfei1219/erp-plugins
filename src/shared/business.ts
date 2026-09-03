export type BusinessId = 'unit-initial-approval' | 'goods-receipt' | 'purchase-order'

export interface BusinessDefinition {
  id: BusinessId
  name: string
  moduleName: string
  documentName: string
  fixtureName: string
  description: string
}

export const BUSINESS_DEFINITIONS: Record<BusinessId, BusinessDefinition> = {
  'unit-initial-approval': {
    id: 'unit-initial-approval',
    name: '单位首营审批',
    moduleName: '购货首营管理',
    documentName: '单位首营资料',
    fixtureName: '单位首营模拟资料',
    description: '识别企业基本信息及证照资料'
  },
  'goods-receipt': {
    id: 'goods-receipt',
    name: '商品收货登记',
    moduleName: '商品收货管理',
    documentName: '随货同行单',
    fixtureName: '随货同行单测试数据',
    description: '识别供应商、运输信息及商品明细'
  },
  'purchase-order': {
    id: 'purchase-order',
    name: '采购订单',
    moduleName: '采购业务管理',
    documentName: '供应商销售出库单',
    fixtureName: '采购订单测试数据',
    description: '识别供应商、发货信息并逐行保留采购商品'
  }
}

export interface ErpPageContext {
  businessId: BusinessId | null
  ename: string | null
  cname: string | null
  mode: string | null
  title: string
  frameUrl: string
  supported: boolean
  isNew: boolean
}

export interface ExtractionEvidence {
  sourcePages: number[]
  confidence: number
  reviewRequired: boolean
}

export interface UnitInitialApprovalHeader {
  referenceYaoshibang: string | null
  referenceYaobang: string | null
  unitCode: string | null
  exists: string | boolean | null
  unitName: string | null
  buyerName: string | null
  businessDivision: string | null
  buyerIdCardNo: string | null
  companyBankName: string | null
  unitShortName: string | null
  businessLicenseNo: string | null
  legalRepresentative: string | null
  companyTaxNo: string | null
  registeredAddress: string | null
  companyInvoiceType: string | null
  selfPickupName: string | null
  warehouseAddress: string | null
  companyAccountName: string | null
  selfPickupIdCardNo: string | null
  unitPhone: string | null
  companyBankAccount: string | null
  siteInspectionStatus: string | null
  qualityResponsiblePerson: string | null
  unitType: string | null
  invoiceContactPhone: string | null
  enterpriseResponsiblePerson: string | null
  receivingPerson: string | null
  receivingPhone: string | null
  receivingAddress: string | null
  earliestQualificationExpiryDate: string | null
  qualificationExpiryReminder: string | null
  businessScope: string[]
}

export interface QualificationRow {
  dataType: string
  certificateNo: string | null
  issuingAuthority: string | null
  issueDate: string | null
  expiryDate: string | null
  expiryControl: boolean
  materialProvided: boolean
  sourcePages: number[]
}

export interface UnitInitialApprovalExtraction {
  documentType: 'unit-initial-approval'
  header: UnitInitialApprovalHeader
  qualificationRows: QualificationRow[]
  fieldEvidence: Record<string, ExtractionEvidence>
  recognizedFieldCount: number
  missingRecommendedFields: string[]
  reviewRequired: string[]
  readyForAutofill: boolean
}

export interface GoodsReceiptHeader {
  supplierName: string | null
  departureDate: string | null
  carrierName: string | null
  transportMethod: string | null
  receiptDateTime: string | null
  surfaceTemperature: number | null
  transportProcessTemperatureStatus: string | null
  transportVehicle: string | null
  departurePlace: string | null
  departureDateTime: string | null
  receiptDateTimeDetail: string | null
  actualTransportHours: number | null
  receiptRemark: string | null
  goodsAccountConsistency: string | null
  deliveryNoteCompliance: string | null
  enclosedVehicle: string | null
  logisticsVoucherCompliance: string | null
  transportTimeLimitStatus: string | null
}

export interface GoodsReceiptItem {
  productName: string
  specification: string | null
  manufacturer: string | null
  marketingAuthorizationHolder: string | null
  unit: string | null
  packageQuantity: number | null
  arrivalQuantity: number | null
  receiptQuantity: number | null
  unitPrice: number | null
  amount: number | null
  batchNumber: string | null
  productionDate: string | null
  expiryDate: string | null
  approvalNumber: string | null
  dosageForm: string | null
  pieceRatio: number | null
  remark: string | null
  sourcePages: number[]
}

export interface GoodsReceiptExtraction {
  documentType: 'goods-receipt'
  header: GoodsReceiptHeader
  items: GoodsReceiptItem[]
  fieldEvidence: Record<string, ExtractionEvidence>
  recognizedFieldCount: number
  missingRecommendedFields: string[]
  reviewRequired: string[]
  readyForAutofill: boolean
}

export interface PurchaseOrderHeader {
  supplierName: string | null
  sourceOrderNumber: string | null
  invoiceDate: string | null
  departureDate: string | null
  customerName: string | null
  receivingAddress: string | null
  carrierName: string | null
  transportMethod: string | null
  coldChain: string | null
  transportTimeLimit: number | null
  receiptRemark: string | null
  remark: string | null
  paymentMethod: string | null
  groupName: string | null
}

export interface PurchaseOrderItem {
  productName: string
  specification: string | null
  dosageForm: string | null
  manufacturer: string | null
  origin: string | null
  approvalNumber: string | null
  marketingAuthorizationHolder: string | null
  unit: string | null
  packageQuantity: number | null
  quantity: number | null
  taxIncludedUnitPrice: number | null
  taxIncludedAmount: number | null
  batchNumber: string | null
  productionDate: string | null
  expiryDate: string | null
  qualityStatus: string | null
  sourcePages: number[]
}

export interface PurchaseOrderExtraction {
  documentType: 'purchase-order'
  header: PurchaseOrderHeader
  items: PurchaseOrderItem[]
  fieldEvidence: Record<string, ExtractionEvidence>
  recognizedFieldCount: number
  missingRecommendedFields: string[]
  reviewRequired: string[]
  readyForAutofill: boolean
}

export type BusinessExtraction =
  | UnitInitialApprovalExtraction
  | GoodsReceiptExtraction
  | PurchaseOrderExtraction

export function isBusinessExtractionFor(
  businessId: BusinessId,
  extraction: BusinessExtraction
): boolean {
  return extraction.documentType === businessId
}

export type WorkflowStatus =
  | 'ready'
  | 'previewing'
  | 'recognizing'
  | 'reviewing'
  | 'filling'
  | 'completed'
  | 'failed'

export interface WorkflowSession {
  sessionId: string
  businessId: BusinessId
  status: WorkflowStatus
  createdAt: number
}
