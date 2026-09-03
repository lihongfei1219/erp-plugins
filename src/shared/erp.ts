import type { BusinessId, ErpPageContext } from './business'

export const ERP_IPC = {
  getState: 'erp:get-state',
  goBack: 'erp:go-back',
  goForward: 'erp:go-forward',
  reload: 'erp:reload',
  setAssistantWidth: 'erp:set-assistant-width',
  fillFixture: 'erp:fill-fixture',
  fillSession: 'erp:fill-session',
  stateChanged: 'erp:state-changed'
} as const

export type ErpLoadStatus = 'not-configured' | 'loading' | 'ready' | 'error'

export interface ErpState {
  configured: boolean
  status: ErpLoadStatus
  url: string | null
  canGoBack: boolean
  canGoForward: boolean
  message: string | null
  currentPage: ErpPageContext | null
}

export type ErpAutofillStatus = 'filled' | 'wrong-page' | 'unavailable' | 'failed'

export interface ErpAutofillResult {
  status: ErpAutofillStatus
  message: string
  filledHeaderFields: number
  filledDetailRows: number
  skippedFields: string[]
}

export interface ErpBusinessRequest {
  businessId: BusinessId
}

export interface ErpFillSessionRequest extends ErpBusinessRequest {
  sessionId: string
}
