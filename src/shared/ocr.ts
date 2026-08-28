export const OCR_IPC = {
  selectDocument: 'ocr:select-document',
  extractDocument: 'ocr:extract-document',
  cancelDocument: 'ocr:cancel-document',
  progress: 'ocr:progress'
} as const

export interface OcrDocumentPreviewPage {
  pageNumber: number
  thumbnailDataUrl: string
}

export interface OcrDocumentPreview {
  token: string
  fileName: string
  pageCount: number
  pages: OcrDocumentPreviewPage[]
}

export interface OcrPreviewResult {
  status: 'cancelled' | 'ready' | 'failed'
  message: string
  preview: OcrDocumentPreview | null
}

export interface OcrExtractionRequest {
  token: string
  excludedPages: number[]
}

export interface DocumentExtractionOptions {
  excludedPages?: number[]
}

export type OcrStage =
  | 'queued'
  | 'reading'
  | 'rendering'
  | 'recognizing'
  | 'extracting'
  | 'completed'
export interface OcrProgress {
  stage: OcrStage
  current: number
  total: number
  message: string
}

export interface OcrBlock {
  text: string
  confidence: number
  boundingBox: number[] | null
}

export interface OcrPage {
  pageNumber: number
  source: 'pi-ocr' | 'skipped-user' | 'skipped-error'
  text: string
  blocks: OcrBlock[]
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

export interface OcrDocumentResult {
  fileName: string
  pageCount: number
  blockCount: number
  ocrPages: number
  engine: string
  modelVersion: string
  elapsedMs: number
  coveragePercent: number
  warnings: string[]
  pages: OcrPage[]
  extractedData: UnitInitialApprovalExtraction | null
}

export interface OcrClientResult {
  status: 'cancelled' | 'completed' | 'failed'
  message: string
  result: OcrDocumentResult | null
}
