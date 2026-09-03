const REPEATED_FINISH_REASON = /^Provider finish_reason:\s*repeated\s*$/i
const HTML_BLOCK_BREAK = /(?:<(?:br|hr)\b[^>]*>|<\/(?:address|article|aside|blockquote|caption|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\s*>)/gi
const HTML_TAG = /<[^>]+>/g
const MARKDOWN_FENCE = /^\s*```(?:html|xml|markdown|md|text)?\s*\n?([\s\S]*?)\n?```\s*$/i
const NO_TEXT_RESPONSE = /^(?:\[?\s*)?(?:未检测到(?:任何)?文字|没有(?:可识别|检测到)文字|无法识别(?:出)?文字|no\s+(?:readable\s+)?text(?:\s+(?:detected|found))?)(?:\s*\]?)?[.!。！]?$/i

export interface OcrAttemptResult {
  text: string
  errorMessage?: string
}

export interface OcrRecoveryResult {
  text: string
  attempts: number
  usedPartialResult: boolean
}

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

/**
 * Qwen3.5-OCR can occasionally answer with a fenced HTML image placeholder
 * instead of transcribing the supplied image. Strip presentation markup and
 * only accept characters that would actually be visible to a user.
 */
export function normalizeUsableOcrText(value: string): string | null {
  const fenced = value.trim().match(MARKDOWN_FENCE)?.[1] ?? value.trim()
  const text = decodeCommonHtmlEntities(
    fenced
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<img\b[^>]*>/gi, '')
      .replace(HTML_BLOCK_BREAK, '\n')
      .replace(HTML_TAG, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (text.length < 8) return null
  if (NO_TEXT_RESPONSE.test(text)) return null
  const visibleCharacters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0
  return visibleCharacters >= 4 ? text : null
}

export function isRepeatedFinishReason(message: string | undefined): boolean {
  return Boolean(message && REPEATED_FINISH_REASON.test(message))
}

/**
 * Qwen OCR may stop a response with the provider-specific `repeated` reason.
 * Pi currently maps unknown finish reasons to errors, even though the streamed
 * assistant message can already contain useful OCR text. Retry once and only
 * fall back to that partial text when the retry is also repetition-stopped.
 */
export async function runOcrWithRepeatedRecovery(
  runAttempt: (attempt: number) => Promise<OcrAttemptResult>,
  maxAttempts = 2
): Promise<OcrRecoveryResult> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('OCR 重试次数必须是正整数')
  }

  let repeatedFallback: string | null = null
  let sawRepeatedFinish = false
  let sawUnusableResponse = false

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAttempt(attempt)
    const text = normalizeUsableOcrText(result.text)

    if (!result.errorMessage) {
      if (text) {
        return { text, attempts: attempt, usedPartialResult: false }
      }
      sawUnusableResponse = true
      continue
    }

    if (!isRepeatedFinishReason(result.errorMessage)) {
      throw new Error(result.errorMessage)
    }
    sawRepeatedFinish = true
    if (text) repeatedFallback = text
  }

  if (repeatedFallback) {
    return {
      text: repeatedFallback,
      attempts: maxAttempts,
      usedPartialResult: true
    }
  }
  if (sawRepeatedFinish) {
    return { text: '', attempts: maxAttempts, usedPartialResult: true }
  }
  if (sawUnusableResponse) {
    throw new Error('OCR 模型连续返回空文本或图片占位符，没有可用的票据文字')
  }
  throw new Error('OCR 模型因重复输出中止，且没有返回可用的部分文本')
}
