import type { ErpAutofillResult } from './erp'
import type { OcrDocumentResult, OcrProgress } from './ocr'

// Keep the existing IPC names and cache directory compatible with purchase caches.
export type QueueBusinessId = 'purchase-order' | 'goods-receipt'
export function isQueueBusiness(value: unknown): value is QueueBusinessId {
  return value === 'purchase-order' || value === 'goods-receipt'
}

export const PURCHASE_QUEUE_IPC = {
  list: 'purchase-queue:list', add: 'purchase-queue:add', get: 'purchase-queue:get',
  retry: 'purchase-queue:retry', cancel: 'purchase-queue:cancel', remove: 'purchase-queue:remove',
  fill: 'purchase-queue:fill', preview: 'purchase-queue:preview', closePreview: 'purchase-queue:close-preview',
  resetUsage: 'purchase-queue:reset-usage', changed: 'purchase-queue:changed'
} as const

export type PurchaseRecognitionStatus = 'queued' | 'recognizing' | 'ready' | 'failed' | 'paused' | 'cancelled'
export type PurchaseUsageStatus = 'available' | 'filling' | 'partial' | 'filled' | 'uncertain'

export interface PurchaseQueueTask {
  businessId: QueueBusinessId
  taskId: string
  batchId: string
  sequence: number
  fileName: string
  createdAt: number
  updatedAt: number
  revision: number
  recognitionStatus: PurchaseRecognitionStatus
  usageStatus: PurchaseUsageStatus
  progress: Omit<OcrProgress, 'sessionId' | 'businessId'> | null
  message: string
  supplierName: string | null
  sourceOrderNumber: string | null
  readyForAutofill: boolean
  boundPageId: string | null
  lastFill: ErpAutofillResult | null
}

export interface PurchaseQueueTaskDetail extends PurchaseQueueTask {
  result: OcrDocumentResult | null
}

export interface PurchaseQueueImportResult {
  added: string[]
  errors: { fileName: string; message: string }[]
}

export interface PurchaseQueuePreview {
  fileName: string
  pageCount: number
  pages: { pageNumber: number; thumbnailDataUrl: string }[]
}

export interface PurchaseQueueApi {
  list: () => Promise<PurchaseQueueTask[]>
  add: (businessId: QueueBusinessId) => Promise<PurchaseQueueImportResult>
  addDropped: (businessId: QueueBusinessId, token: string) => Promise<PurchaseQueueImportResult>
  get: (taskId: string) => Promise<PurchaseQueueTaskDetail>
  retry: (taskId: string) => Promise<void>
  cancel: (taskId: string) => Promise<void>
  remove: (taskId: string) => Promise<void>
  resetUsage: (taskId: string) => Promise<void>
  fill: (request: { taskId: string; pageId: string }) => Promise<ErpAutofillResult>
  preview: (taskId: string) => Promise<PurchaseQueuePreview>
  closePreview: () => Promise<void>
  onChanged: (listener: () => void) => () => void
}
