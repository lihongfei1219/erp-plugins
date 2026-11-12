import type { UnitInitialApprovalExtraction } from '../shared/business'
import type { OcrClientResult, OcrDocumentBatchItem, OcrDocumentResult, OcrPage } from '../shared/ocr'
import { getExtractionAdapter } from './businesses/extraction-registry'
import type { PendingDocumentSelection } from './workflow-session-manager'

const REFUSAL_PATTERN = /sensitive|content\s*policy|data\s*inspection|not\s*allowed|refus|高敏|安全策略|内容审核|内容合规/i

export function friendlyBatchError(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim()
  if (REFUSAL_PATTERN.test(compact)) return '模型拒绝处理该文件，可能包含不支持识别的内容'
  if (!compact) return '识别失败，请稍后重试'
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact
}

function offsetPages(pages: number[], offset: number): number[] {
  return pages.map((page) => page + offset)
}

function remapExtraction(
  extraction: UnitInitialApprovalExtraction,
  offset: number
): UnitInitialApprovalExtraction {
  return {
    ...extraction,
    header: { ...extraction.header, businessScope: [...extraction.header.businessScope] },
    qualificationRows: extraction.qualificationRows.map((row) => ({
      ...row,
      sourcePages: offsetPages(row.sourcePages, offset)
    })),
    fieldEvidence: Object.fromEntries(Object.entries(extraction.fieldEvidence).map(([key, evidence]) => [
      key,
      { ...evidence, sourcePages: offsetPages(evidence.sourcePages, offset) }
    ])),
    missingRecommendedFields: [...extraction.missingRecommendedFields],
    reviewRequired: [...extraction.reviewRequired]
  }
}

function publicItems(selection: PendingDocumentSelection): OcrDocumentBatchItem[] {
  return selection.items.map(({ id, fileName, status, message, pageCount }) => ({
    id,
    fileName,
    status,
    message,
    pageCount
  }))
}

export function aggregateUnitDocumentBatch(
  selection: PendingDocumentSelection,
  elapsedMs: number
): OcrClientResult {
  const adapter = getExtractionAdapter('unit-initial-approval')
  let extraction: UnitInitialApprovalExtraction | null = null
  let pageOffset = 0
  let blockCount = 0
  let ocrPages = 0
  let successCount = 0
  const pages: OcrPage[] = []
  const warnings: string[] = []
  const engines = new Set<string>()
  const models = new Set<string>()

  for (const item of selection.items) {
    const document = item.result?.status === 'completed' ? item.result.result : null
    const itemExtraction = document?.extractedData
    if (document && itemExtraction?.documentType === 'unit-initial-approval') {
      const remapped = remapExtraction(itemExtraction, pageOffset)
      const documentPageCount = Math.max(1, document.pageCount)
      extraction = adapter.merge(extraction, remapped, pageOffset + documentPageCount) as UnitInitialApprovalExtraction
      pages.push(...document.pages.map((page) => ({ ...page, pageNumber: page.pageNumber + pageOffset })))
      warnings.push(...document.warnings.map((warning) => `${item.fileName}：${warning}`))
      pageOffset += documentPageCount
      blockCount += document.blockCount
      ocrPages += document.ocrPages
      successCount++
      if (document.engine) engines.add(document.engine)
      if (document.modelVersion) models.add(document.modelVersion)
      continue
    }

    pages.push({ pageNumber: pageOffset + 1, source: 'skipped-error', text: '', blocks: [] })
    warnings.push(`${item.fileName}：${friendlyBatchError(item.message)}`)
    pageOffset++
  }

  const failedCount = selection.items.length - successCount
  const result: OcrDocumentResult = {
    businessId: 'unit-initial-approval',
    fileName: `${selection.items.length} 个单位资料文件`,
    pageCount: pageOffset,
    blockCount,
    ocrPages,
    engine: [...engines].join(' / ') || 'pi-agent-incremental',
    modelVersion: [...models].join(' / '),
    elapsedMs,
    coveragePercent: extraction ? adapter.coverage(extraction) : 0,
    warnings,
    pages,
    extractedData: extraction,
    batchItems: publicItems(selection)
  }

  if (!extraction) {
    return {
      status: 'failed',
      message: `本批 ${selection.items.length} 个文件均未能识别，请查看失败原因后重试`,
      result
    }
  }
  return {
    status: 'completed',
    message: failedCount > 0
      ? `已识别 ${successCount} 个文件，${failedCount} 个文件失败；成功结果已合并，可单独重试失败文件`
      : `已识别并合并全部 ${successCount} 个单位资料文件`,
    result
  }
}
