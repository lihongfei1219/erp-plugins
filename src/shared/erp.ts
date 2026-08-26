export const ERP_IPC = {
  getState: 'erp:get-state',
  goBack: 'erp:go-back',
  goForward: 'erp:go-forward',
  reload: 'erp:reload',
  fillMockData: 'erp:fill-mock-data',
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
}

export type ErpAutofillStatus = 'filled' | 'wrong-page' | 'unavailable' | 'failed'

export interface ErpAutofillResult {
  status: ErpAutofillStatus
  message: string
  filledHeaderFields: number
  filledQualificationRows: number
  skippedFields: string[]
}
