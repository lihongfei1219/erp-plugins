export interface PiModelEndpointConfig {
  providerId: string
  baseUrl: string
  modelId: string
  apiKey: string
  supportsImages: boolean
  contextWindow: number
  maxTokens: number
}

export interface PiAgentConfig {
  ocr: PiModelEndpointConfig
  normalizer: PiModelEndpointConfig
  maxUploadBytes: number
  maxPages: number
  ocrConcurrency: number
  pageTimeoutMs: number
  normalizationTimeoutMs: number
}

function configuredValue(viteValue: string | undefined, processName: string): string | undefined {
  return viteValue?.trim() || process.env[processName]?.trim() || undefined
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
  return parsed
}

function httpBaseUrl(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`缺少 ${name}，请先在 .env 中配置 Pi 模型接口地址`)
  }

  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} 只支持 HTTP 或 HTTPS 地址`)
  }
  return url.toString().replace(/\/$/, '')
}

export function loadPiAgentConfig(): PiAgentConfig {
  const ocrBaseUrl = httpBaseUrl(
    configuredValue(import.meta.env.MAIN_VITE_PI_OCR_BASE_URL, 'MAIN_VITE_PI_OCR_BASE_URL'),
    'MAIN_VITE_PI_OCR_BASE_URL'
  )
  const normalizerBaseUrl = httpBaseUrl(
    configuredValue(
      import.meta.env.MAIN_VITE_PI_NORMALIZER_BASE_URL,
      'MAIN_VITE_PI_NORMALIZER_BASE_URL'
    ) ?? ocrBaseUrl,
    'MAIN_VITE_PI_NORMALIZER_BASE_URL'
  )
  const bundledApiKey = import.meta.env.DASHSCOPE_API_KEY?.trim() || ''
  const sharedApiKey =
    process.env.DASHSCOPE_API_KEY?.trim() ||
    process.env.PI_API_KEY?.trim() ||
    bundledApiKey

  return {
    ocr: {
      providerId: 'erp-qwen-ocr',
      baseUrl: ocrBaseUrl,
      modelId:
        configuredValue(import.meta.env.MAIN_VITE_PI_OCR_MODEL, 'MAIN_VITE_PI_OCR_MODEL') ??
        'qwen3.5-ocr',
      apiKey: process.env.PI_OCR_API_KEY?.trim() || sharedApiKey,
      supportsImages: true,
      contextWindow: positiveInteger(
        configuredValue(
          import.meta.env.MAIN_VITE_PI_OCR_CONTEXT_WINDOW,
          'MAIN_VITE_PI_OCR_CONTEXT_WINDOW'
        ),
        65536,
        'MAIN_VITE_PI_OCR_CONTEXT_WINDOW'
      ),
      maxTokens: 16384
    },
    normalizer: {
      providerId: 'erp-field-normalizer',
      baseUrl: normalizerBaseUrl,
      modelId:
        configuredValue(
          import.meta.env.MAIN_VITE_PI_NORMALIZER_MODEL,
          'MAIN_VITE_PI_NORMALIZER_MODEL'
        ) ?? 'deepseek-v4-flash-0731',
      apiKey: process.env.PI_NORMALIZER_API_KEY?.trim() || sharedApiKey,
      supportsImages: false,
      contextWindow: positiveInteger(
        configuredValue(
          import.meta.env.MAIN_VITE_PI_NORMALIZER_CONTEXT_WINDOW,
          'MAIN_VITE_PI_NORMALIZER_CONTEXT_WINDOW'
        ),
        1000000,
        'MAIN_VITE_PI_NORMALIZER_CONTEXT_WINDOW'
      ),
      maxTokens: 16384
    },
    maxUploadBytes:
      positiveInteger(
        configuredValue(import.meta.env.MAIN_VITE_PI_MAX_UPLOAD_MB, 'MAIN_VITE_PI_MAX_UPLOAD_MB'),
        100,
        'MAIN_VITE_PI_MAX_UPLOAD_MB'
      ) *
      1024 *
      1024,
    maxPages: positiveInteger(
      configuredValue(import.meta.env.MAIN_VITE_PI_MAX_PAGES, 'MAIN_VITE_PI_MAX_PAGES'),
      50,
      'MAIN_VITE_PI_MAX_PAGES'
    ),
    ocrConcurrency: positiveInteger(
      configuredValue(
        import.meta.env.MAIN_VITE_PI_OCR_CONCURRENCY,
        'MAIN_VITE_PI_OCR_CONCURRENCY'
      ),
      8,
      'MAIN_VITE_PI_OCR_CONCURRENCY'
    ),
    pageTimeoutMs: positiveInteger(
      configuredValue(
        import.meta.env.MAIN_VITE_PI_PAGE_TIMEOUT_MS,
        'MAIN_VITE_PI_PAGE_TIMEOUT_MS'
      ),
      180000,
      'MAIN_VITE_PI_PAGE_TIMEOUT_MS'
    ),
    normalizationTimeoutMs: positiveInteger(
      configuredValue(
        import.meta.env.MAIN_VITE_PI_NORMALIZATION_TIMEOUT_MS,
        'MAIN_VITE_PI_NORMALIZATION_TIMEOUT_MS'
      ),
      180000,
      'MAIN_VITE_PI_NORMALIZATION_TIMEOUT_MS'
    )
  }
}
