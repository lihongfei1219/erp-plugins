/// <reference types="vite/client" />

import type {
  ErpAutofillResult,
  ErpBusinessRequest,
  ErpFillSessionRequest,
  ErpState
} from '../../shared/erp'
import type {
  OcrCancelRequest,
  OcrClientResult,
  OcrDocumentSelectionRequest,
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
    setAssistantWidth: (width: number) => Promise<void>
    fillFixture: (request: ErpBusinessRequest) => Promise<ErpAutofillResult>
    fillSession: (request: ErpFillSessionRequest) => Promise<ErpAutofillResult>
    onStateChanged: (listener: (state: ErpState) => void) => void
  }
  readonly ocr: {
    selectDocument: (request: OcrDocumentSelectionRequest) => Promise<OcrPreviewResult>
    extractDocument: (request: OcrExtractionRequest) => Promise<OcrClientResult>
    cancelDocument: (request: OcrCancelRequest) => Promise<void>
    onProgress: (listener: (progress: OcrProgress) => void) => void
  }
}

declare global {
  interface Window {
    readonly desktop: DesktopApi
  }
}

export {}
