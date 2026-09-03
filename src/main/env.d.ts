interface ImportMetaEnv {
  readonly DASHSCOPE_API_KEY?: string
  readonly MAIN_VITE_ERP_URL?: string
  readonly MAIN_VITE_ALLOWED_ORIGINS?: string
  readonly MAIN_VITE_PI_OCR_BASE_URL?: string
  readonly MAIN_VITE_PI_OCR_MODEL?: string
  readonly MAIN_VITE_PI_OCR_CONTEXT_WINDOW?: string
  readonly MAIN_VITE_PI_NORMALIZER_BASE_URL?: string
  readonly MAIN_VITE_PI_NORMALIZER_MODEL?: string
  readonly MAIN_VITE_PI_NORMALIZER_CONTEXT_WINDOW?: string
  readonly MAIN_VITE_PI_MAX_UPLOAD_MB?: string
  readonly MAIN_VITE_PI_MAX_PAGES?: string
  readonly MAIN_VITE_PI_OCR_CONCURRENCY?: string
  readonly MAIN_VITE_PI_PAGE_TIMEOUT_MS?: string
  readonly MAIN_VITE_PI_NORMALIZATION_TIMEOUT_MS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
