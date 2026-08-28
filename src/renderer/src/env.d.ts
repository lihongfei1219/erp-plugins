/// <reference types="vite/client" />

import type { ErpAutofillResult, ErpState } from '../../shared/erp'
import type {
  OcrClientResult,
  OcrDocumentPreview,
  OcrExtractionRequest,
  OcrPreviewResult,
  OcrProgress
} from '../../shared/ocr'

interface DesktopApi {
  readonly platform: NodeJS.Platform
  readonly erp: {
    getState: () => Promise<ErpState>
    goBack: () => Promise<void>
    goForward: () => Promise<void>
    reload: () => Promise<void>
    fillMockData: () => Promise<ErpAutofillResult>
    onStateChanged: (listener: (state: ErpState) => void) => void
  }
  readonly ocr: {
    selectDocument: () => Promise<OcrPreviewResult>
    extractDocument: (request: OcrExtractionRequest) => Promise<OcrClientResult>
    cancelDocument: (token: OcrDocumentPreview['token']) => Promise<void>
    onProgress: (listener: (progress: OcrProgress) => void) => void
  }
}

declare global {
  interface Window {
    readonly desktop: DesktopApi
  }
}

export {}
