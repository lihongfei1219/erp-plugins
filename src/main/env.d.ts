interface ImportMetaEnv {
  readonly MAIN_VITE_ERP_URL?: string
  readonly MAIN_VITE_ALLOWED_ORIGINS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
