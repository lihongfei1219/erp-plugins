import type { BusinessExtraction, BusinessId } from './business'

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
  sessionId: string
  businessId: BusinessId
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
  sessionId: string
  businessId: BusinessId
  token: string
  excludedPages: number[]
}

export interface OcrCancelRequest {
  sessionId: string
  businessId: BusinessId
  token: string
}

export interface OcrDocumentSelectionRequest {
  sessionId: string
  businessId: BusinessId
}

export interface DocumentExtractionOptions {
  businessId: BusinessId
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
  sessionId: string
  businessId: BusinessId
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
}

export interface OcrClientResult {
  status: 'cancelled' | 'completed' | 'failed'
  message: string
  result: OcrDocumentResult | null
}
