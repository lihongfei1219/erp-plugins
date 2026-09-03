import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  BusinessExtraction,
  BusinessId,
  GoodsReceiptExtraction,
  PurchaseOrderExtraction,
  UnitInitialApprovalExtraction
} from '../../shared/business'
import {
  createUnitInitialApprovalSubmissionTool,
  normalizeUnitInitialApprovalSubmission,
  unitInitialApprovalSystemPrompt,
  type UnitInitialApprovalSubmission
} from '../agent/unit-initial-approval-tool'
import {
  calculateExtractionCoverage,
  mergeExtractions
} from '../agent/incremental-extraction'
import {
  calculateGoodsReceiptCoverage,
  createGoodsReceiptSubmissionTool,
  goodsReceiptSystemPrompt,
  mergeGoodsReceiptExtractions,
  normalizeGoodsReceiptSubmission,
  type GoodsReceiptSubmission
} from './goods-receipt-tool'
import {
  calculatePurchaseOrderCoverage,
  createPurchaseOrderSubmissionTool,
  mergePurchaseOrderExtractions,
  normalizePurchaseOrderSubmission,
  purchaseOrderSystemPrompt,
  type PurchaseOrderSubmission
} from './purchase-order-tool'

export interface BusinessExtractionAdapter {
  id: BusinessId
  submissionToolName: string
  systemPrompt: string
  createSubmissionTool: (submit: (submission: unknown) => void) => AgentTool
  normalize: (submission: unknown, pageCount: number) => BusinessExtraction
  merge: (
    current: BusinessExtraction | null,
    incoming: BusinessExtraction,
    pageCount: number
  ) => BusinessExtraction
  coverage: (extraction: BusinessExtraction) => number
}

const adapters: Record<BusinessId, BusinessExtractionAdapter> = {
  'unit-initial-approval': {
    id: 'unit-initial-approval',
    submissionToolName: 'submit_unit_initial_approval',
    systemPrompt: unitInitialApprovalSystemPrompt(),
    createSubmissionTool: (submit) =>
      createUnitInitialApprovalSubmissionTool((submission) => submit(submission)) as AgentTool,
    normalize: (submission, pageCount) =>
      normalizeUnitInitialApprovalSubmission(
        submission as UnitInitialApprovalSubmission,
        pageCount
      ),
    merge: (current, incoming, pageCount) =>
      mergeExtractions(
        current as UnitInitialApprovalExtraction | null,
        incoming as UnitInitialApprovalExtraction,
        pageCount
      ),
    coverage: (extraction) =>
      calculateExtractionCoverage(extraction as UnitInitialApprovalExtraction).percent
  },
  'goods-receipt': {
    id: 'goods-receipt',
    submissionToolName: 'submit_goods_receipt',
    systemPrompt: goodsReceiptSystemPrompt(),
    createSubmissionTool: (submit) =>
      createGoodsReceiptSubmissionTool((submission) => submit(submission)) as AgentTool,
    normalize: (submission, pageCount) =>
      normalizeGoodsReceiptSubmission(submission as GoodsReceiptSubmission, pageCount),
    merge: (current, incoming, pageCount) =>
      mergeGoodsReceiptExtractions(
        current as GoodsReceiptExtraction | null,
        incoming as GoodsReceiptExtraction,
        pageCount
      ),
    coverage: (extraction) => calculateGoodsReceiptCoverage(extraction as GoodsReceiptExtraction)
  },
  'purchase-order': {
    id: 'purchase-order',
    submissionToolName: 'submit_purchase_order',
    systemPrompt: purchaseOrderSystemPrompt(),
    createSubmissionTool: (submit) =>
      createPurchaseOrderSubmissionTool((submission) => submit(submission)) as AgentTool,
    normalize: (submission, pageCount) =>
      normalizePurchaseOrderSubmission(submission as PurchaseOrderSubmission, pageCount),
    merge: (current, incoming) =>
      mergePurchaseOrderExtractions(
        current as PurchaseOrderExtraction | null,
        incoming as PurchaseOrderExtraction
      ),
    coverage: (extraction) =>
      calculatePurchaseOrderCoverage(extraction as PurchaseOrderExtraction)
  }
}

export function getExtractionAdapter(businessId: BusinessId): BusinessExtractionAdapter {
  return adapters[businessId]
}
