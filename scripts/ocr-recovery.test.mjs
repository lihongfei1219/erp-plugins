import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRepeatedFinishReason,
  normalizeUsableOcrText,
  runOcrWithRepeatedRecovery
} from '../src/main/agent/ocr-recovery.ts'
import { normalizeExcludedPages } from '../src/main/page-selection.ts'

const REPEATED = 'Provider finish_reason: repeated'

test('recognizes only the provider repeated finish reason', () => {
  assert.equal(isRepeatedFinishReason(REPEATED), true)
  assert.equal(isRepeatedFinishReason('Provider finish_reason: length'), false)
  assert.equal(isRepeatedFinishReason(undefined), false)
})

test('returns a normal OCR response without retrying', async () => {
  let calls = 0
  const result = await runOcrWithRepeatedRecovery(async () => {
    calls += 1
    return { text: '营业执照\n统一社会信用代码 1234567890' }
  })

  assert.equal(calls, 1)
  assert.deepEqual(result, {
    text: '营业执照\n统一社会信用代码 1234567890',
    attempts: 1,
    usedPartialResult: false
  })
})

test('rejects an HTML image placeholder as OCR text', () => {
  assert.equal(
    normalizeUsableOcrText('```html\n<html><body><div class="image"><img/></div></body></html>\n```'),
    null
  )
})

test('keeps visible text while removing accidental HTML presentation markup', () => {
  assert.equal(
    normalizeUsableOcrText('<html><body><div>出库单号：SCKGAK000007111</div><div>客户名称：吉林柏锦医药有限公司</div></body></html>'),
    '出库单号：SCKGAK000007111\n客户名称：吉林柏锦医药有限公司'
  )
})

test('retries an image placeholder and accepts the next transcription', async () => {
  const result = await runOcrWithRepeatedRecovery(async (attempt) =>
    attempt === 1
      ? { text: '<html><body><div class="image"><img/></div></body></html>' }
      : { text: '江西康强医药有限公司销售出库清单\n出库单号：SCKGAK000007111' }
  )

  assert.equal(result.attempts, 2)
  assert.match(result.text, /江西康强医药有限公司/)
})

test('reports consecutive placeholder responses as unusable', async () => {
  await assert.rejects(
    runOcrWithRepeatedRecovery(async () => ({
      text: '<html><body><div class="image"><img/></div></body></html>'
    })),
    /空文本或图片占位符/
  )
})

test('retries a repeated response and prefers the complete retry', async () => {
  const result = await runOcrWithRepeatedRecovery(async (attempt) =>
    attempt === 1
      ? { text: '法人授权委托书（部分）', errorMessage: REPEATED }
      : { text: '法人授权委托书\n采购员：王某\n授权范围：全国' }
  )

  assert.equal(result.attempts, 2)
  assert.equal(result.usedPartialResult, false)
  assert.match(result.text, /授权范围/)
})

test('uses the latest usable partial text after two repeated responses', async () => {
  const result = await runOcrWithRepeatedRecovery(async (attempt) => ({
    text: attempt === 1 ? '法人授权委托书（第一次部分文本）' : '法人授权委托书（第二次部分文本）',
    errorMessage: REPEATED
  }))

  assert.equal(result.attempts, 2)
  assert.equal(result.usedPartialResult, true)
  assert.match(result.text, /第二次部分文本/)
})

test('does not hide unrelated provider errors', async () => {
  await assert.rejects(
    runOcrWithRepeatedRecovery(async () => ({
      text: '已有部分文本但请求失败',
      errorMessage: 'Provider finish_reason: content_filter'
    })),
    /content_filter/
  )
})

test('returns an empty partial result when repeated responses contain no usable text', async () => {
  const result = await runOcrWithRepeatedRecovery(async () => ({
    text: '...',
    errorMessage: REPEATED
  }))
  assert.deepEqual(result, { text: '', attempts: 2, usedPartialResult: true })
})

test('normalizes user-excluded page numbers', () => {
  assert.deepEqual(normalizeExcludedPages([16, 2, 16], 24), [2, 16])
  assert.deepEqual(normalizeExcludedPages(undefined, 24), [])
  assert.throws(() => normalizeExcludedPages([0], 24), /超出/)
  assert.throws(() => normalizeExcludedPages([25], 24), /超出/)
})
