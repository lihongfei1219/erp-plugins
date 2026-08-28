const REPEATED_FINISH_REASON = /^Provider finish_reason:\s*repeated\s*$/i

export interface OcrAttemptResult {
  text: string
  errorMessage?: string
}

export interface OcrRecoveryResult {
  text: string
  attempts: number
  usedPartialResult: boolean
}

function usableOcrText(value: string): string | null {
  const text = value.trim()
  if (text.length < 8) return null
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAttempt(attempt)
    const text = usableOcrText(result.text)

    if (!result.errorMessage) {
      if (text) {
        return { text, attempts: attempt, usedPartialResult: false }
      }
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
  throw new Error('OCR 模型因重复输出中止，且没有返回可用的部分文本')
}
