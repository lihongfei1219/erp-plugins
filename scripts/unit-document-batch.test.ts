import assert from 'node:assert/strict'
import test from 'node:test'
import type { UnitInitialApprovalExtraction } from '../src/shared/business'
import type { OcrClientResult, OcrDocumentResult } from '../src/shared/ocr'
import { normalizeUnitInitialApprovalSubmission } from '../src/main/agent/unit-initial-approval-tool'
import { aggregateUnitDocumentBatch, friendlyBatchError } from '../src/main/unit-document-batch'
import { WorkflowSessionManager, type PendingDocumentItem } from '../src/main/workflow-session-manager'

function extraction(
  header: Record<string, unknown>,
  qualificationRows: Array<Record<string, unknown>> = []
): UnitInitialApprovalExtraction {
  return normalizeUnitInitialApprovalSubmission({
    header: { ...header, businessScope: header.businessScope ?? [] },
    qualificationRows,
    evidence: Object.keys(header).filter((key) => key !== 'businessScope').map((fieldPath) => ({
      fieldPath: `header.${fieldPath}`,
      sourcePages: [1],
      confidence: 0.9,
      reviewRequired: false
    })),
    reviewRequired: []
  }, 1)
}

function completed(fileName: string, data: UnitInitialApprovalExtraction): OcrClientResult {
  const result: OcrDocumentResult = {
    businessId: 'unit-initial-approval',
    fileName,
    pageCount: 1,
    blockCount: 1,
    ocrPages: 1,
    engine: 'test-engine',
    modelVersion: 'test-model',
    elapsedMs: 10,
    coveragePercent: 50,
    warnings: [],
    pages: [{ pageNumber: 1, source: 'pi-ocr', text: fileName, blocks: [] }],
    extractedData: data
  }
  return { status: 'completed', message: 'ok', result }
}

function item(id: string, fileName: string, result: OcrClientResult): PendingDocumentItem {
  return {
    id,
    filePath: `C:\\fixtures\\${fileName}`,
    fileName,
    status: result.status === 'completed' ? 'completed' : 'failed',
    message: result.message,
    pageCount: result.result?.pageCount ?? null,
    result
  }
}

test('multiple unit images merge into one dossier and retain global source order', () => {
  const first = extraction(
    { unitName: '测试医药有限公司', businessLicenseNo: 'LIC-001' },
    [{ dataType: '营业执照', certificateNo: 'LIC-001', sourcePages: [1] }]
  )
  const second = extraction(
    { registeredAddress: '测试路 1 号', businessScope: ['药品批发'] },
    [{ dataType: '药品经营许可证', certificateNo: 'PERMIT-002', sourcePages: [1] }]
  )
  const result = aggregateUnitDocumentBatch({
    sessionId: 'session',
    businessId: 'unit-initial-approval',
    token: 'token',
    items: [item('a', 'license.png', completed('license.png', first)), item('b', 'permit.png', completed('permit.png', second))]
  }, 20)

  assert.equal(result.status, 'completed')
  assert.equal(result.result?.pageCount, 2)
  assert.deepEqual(result.result?.pages.map((page) => page.pageNumber), [1, 2])
  const merged = result.result?.extractedData as UnitInitialApprovalExtraction
  assert.equal(merged.header.unitName, '测试医药有限公司')
  assert.equal(merged.header.registeredAddress, '测试路 1 号')
  assert.deepEqual(merged.qualificationRows.map((row) => row.sourcePages), [[1], [2]])
})

test('a refused image is isolated while successful unit images remain usable', () => {
  const success = completed('license.png', extraction({ unitName: '测试医药有限公司' }))
  const refused: OcrClientResult = {
    status: 'failed',
    message: 'request rejected by content policy because sensitive content was detected',
    result: null
  }
  const result = aggregateUnitDocumentBatch({
    sessionId: 'session',
    businessId: 'unit-initial-approval',
    token: 'token',
    items: [item('a', 'license.png', success), item('b', 'sensitive.png', refused)]
  }, 20)

  assert.equal(result.status, 'completed')
  assert.equal(result.result?.batchItems?.[1].status, 'failed')
  assert.match(result.message, /1 个文件失败/)
  assert.match(result.result?.warnings[0] ?? '', /模型拒绝处理/)
  assert.equal((result.result?.extractedData as UnitInitialApprovalExtraction).header.unitName, '测试医药有限公司')
})

test('all failed images return a controlled batch failure', () => {
  const failure: OcrClientResult = { status: 'failed', message: 'service unavailable', result: null }
  const result = aggregateUnitDocumentBatch({
    sessionId: 'session',
    businessId: 'unit-initial-approval',
    token: 'token',
    items: [item('a', 'a.png', failure), item('b', 'b.png', failure)]
  }, 20)
  assert.equal(result.status, 'failed')
  assert.equal(result.result?.extractedData, null)
  assert.equal(result.result?.batchItems?.length, 2)
  assert.doesNotThrow(() => friendlyBatchError(failure.message))
})

test('retry selects only failed files and switching ERP pages aborts a running batch', () => {
  const sessions = new WorkflowSessionManager()
  sessions.bindToPage('session', 'unit-initial-approval', 'page-a')
  sessions.setPending({
    sessionId: 'session',
    businessId: 'unit-initial-approval',
    token: 'token',
    items: [
      { ...item('a', 'a.png', { status: 'failed', message: '', result: null }), status: 'queued' },
      { ...item('b', 'b.png', { status: 'failed', message: '', result: null }), status: 'queued' }
    ]
  })
  const active = sessions.beginPending('session', 'unit-initial-approval', 'token')
  const success = completed('a.png', extraction({ unitName: '测试医药有限公司' }))
  sessions.recordPendingItem('session', 'unit-initial-approval', 'token', 'a', success, 'ok')
  sessions.recordPendingItem('session', 'unit-initial-approval', 'token', 'b', { status: 'failed', message: 'failed', result: null }, 'failed')
  sessions.finishPending('session', 'unit-initial-approval', 'token')

  const retry = sessions.beginPending('session', 'unit-initial-approval', 'token', true)
  assert.deepEqual(retry.items.map((entry) => entry.id), ['b'])
  assert.equal(active.signal.aborted, false)
  sessions.cancelRunningOutsidePage('page-b')
  assert.equal(retry.signal.aborted, true)
  assert.throws(() => sessions.getPending('session', 'unit-initial-approval', 'token'), /失效/)
})
