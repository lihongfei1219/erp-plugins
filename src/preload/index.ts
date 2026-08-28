import { contextBridge, ipcRenderer } from 'electron'
import { ERP_IPC, type ErpAutofillResult, type ErpState } from '../shared/erp'
import {
  OCR_IPC,
  type OcrClientResult,
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
      fillMockData: (): Promise<ErpAutofillResult> => ipcRenderer.invoke(ERP_IPC.fillMockData),
      onStateChanged: (listener: (state: ErpState) => void): void => {
        ipcRenderer.on(ERP_IPC.stateChanged, (_event, state: ErpState) => {
          listener(state)
        })
      }
    }),
    ocr: Object.freeze({
      selectDocument: (): Promise<OcrPreviewResult> =>
        ipcRenderer.invoke(OCR_IPC.selectDocument),
      extractDocument: (request: OcrExtractionRequest): Promise<OcrClientResult> =>
        ipcRenderer.invoke(OCR_IPC.extractDocument, request),
      cancelDocument: (token: string): Promise<void> =>
        ipcRenderer.invoke(OCR_IPC.cancelDocument, token),
      onProgress: (listener: (progress: OcrProgress) => void): void => {
        ipcRenderer.on(OCR_IPC.progress, (_event, progress: OcrProgress) => {
          listener(progress)
        })
      }
    })
  })
)
