import type { BusinessExtraction, BusinessId } from './business'

export const OCR_IPC = {
  selectDocument: 'ocr:select-document',
  extractDocument: 'ocr:extract-document',
  cancelDocument: 'ocr:cancel-document',
  progress: 'ocr:progress'
} as const

export type OcrBatchItemStatus = 'queued' | 'recognizing' | 'completed' | 'failed'

export interface OcrDocumentBatchItem {
  id: string
  fileName: string
  status: OcrBatchItemStatus
  message: string
  pageCount: number | null
}

export interface OcrDocumentBatch {
  sessionId: string
  businessId: BusinessId
  token: string
  items: OcrDocumentBatchItem[]
}

export interface OcrSelectionResult {
  status: 'cancelled' | 'ready' | 'failed'
  message: string
  batch: OcrDocumentBatch | null
}

export interface OcrExtractionRequest {
  sessionId: string
  businessId: BusinessId
  token: string
  retryFailed?: boolean
}

export interface OcrCancelRequest {
  sessionId: string
  businessId: BusinessId
  token: string
}

export interface OcrDocumentSelectionRequest {
  dropToken?: string
  sessionId: string
  businessId: BusinessId
  pageId: string
}

export interface DocumentExtractionOptions {
  businessId: BusinessId
  excludedPages?: number[]
  signal?: AbortSignal
}

export type OcrStage =
  | 'queued'
  | 'reading'
  | 'rendering'
  | 'recognizing'
  | 'extracting'
  | 'completed'

export interface OcrProgress {
  sessionId: string
  businessId: BusinessId
  stage: OcrStage
  current: number
  total: number
  message: string
  itemId?: string
  itemStatus?: OcrBatchItemStatus
  fileName?: string
  completedItems?: number
  failedItems?: number
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

export interface OcrDocumentResult {
  businessId: BusinessId
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
  extractedData: BusinessExtraction | null
  batchItems?: OcrDocumentBatchItem[]
}

export interface OcrClientResult {
  status: 'cancelled' | 'completed' | 'failed'
  message: string
  result: OcrDocumentResult | null
}
