/// <reference types="vite/client" />

import type { ErpAutofillResult, ErpState } from '../../shared/erp'

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
}

declare global {
  interface Window {
    readonly desktop: DesktopApi
  }
}

export {}
