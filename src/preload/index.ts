import { contextBridge, ipcRenderer } from 'electron'
import {
  ERP_IPC,
  type ErpAutofillResult,
  type ErpBusinessRequest,
  type ErpFillSessionRequest,
  type ErpState
} from '../shared/erp'
import {
  OCR_IPC,
  type OcrCancelRequest,
  type OcrClientResult,
  type OcrDocumentSelectionRequest,
  type OcrExtractionRequest,
  type OcrPreviewResult,
  type OcrProgress
} from '../shared/ocr'

contextBridge.exposeInMainWorld(
  'desktop',
  Object.freeze({
    platform: process.platform,
    erp: Object.freeze({
      getState: (): Promise<ErpState> => ipcRenderer.invoke(ERP_IPC.getState),
      goBack: (): Promise<void> => ipcRenderer.invoke(ERP_IPC.goBack),
      goForward: (): Promise<void> => ipcRenderer.invoke(ERP_IPC.goForward),
      reload: (): Promise<void> => ipcRenderer.invoke(ERP_IPC.reload),
      setAssistantWidth: (width: number): Promise<void> =>
        ipcRenderer.invoke(ERP_IPC.setAssistantWidth, width),
      fillFixture: (request: ErpBusinessRequest): Promise<ErpAutofillResult> =>
        ipcRenderer.invoke(ERP_IPC.fillFixture, request),
      fillSession: (request: ErpFillSessionRequest): Promise<ErpAutofillResult> =>
        ipcRenderer.invoke(ERP_IPC.fillSession, request),
      onStateChanged: (listener: (state: ErpState) => void): void => {
        ipcRenderer.on(ERP_IPC.stateChanged, (_event, state: ErpState) => {
          listener(state)
        })
      }
    }),
    ocr: Object.freeze({
      selectDocument: (request: OcrDocumentSelectionRequest): Promise<OcrPreviewResult> =>
        ipcRenderer.invoke(OCR_IPC.selectDocument, request),
      extractDocument: (request: OcrExtractionRequest): Promise<OcrClientResult> =>
        ipcRenderer.invoke(OCR_IPC.extractDocument, request),
      cancelDocument: (request: OcrCancelRequest): Promise<void> =>
        ipcRenderer.invoke(OCR_IPC.cancelDocument, request),
      onProgress: (listener: (progress: OcrProgress) => void): void => {
        ipcRenderer.on(OCR_IPC.progress, (_event, progress: OcrProgress) => {
          listener(progress)
        })
      }
    })
  })
)
