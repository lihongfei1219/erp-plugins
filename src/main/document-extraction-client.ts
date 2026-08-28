import type {
  DocumentExtractionOptions,
  OcrClientResult,
  OcrProgress,
  UnitInitialApprovalExtraction
} from '../shared/ocr'

export interface IncrementalExtractionUpdate {
  extraction: UnitInitialApprovalExtraction
  coveragePercent: number
  completedPages: number
  totalPages: number
}

export interface DocumentExtractionClient {
  extractDocument(
    filePath: string,
    onProgress: (progress: OcrProgress) => void,
    options?: DocumentExtractionOptions,
    onExtractionUpdated?: (
      update: IncrementalExtractionUpdate
    ) => void | Promise<void>
  ): Promise<OcrClientResult>
}

export class UnavailableDocumentExtractionClient implements DocumentExtractionClient {
  constructor(private readonly reason: string) {}

  async extractDocument(): Promise<OcrClientResult> {
    return {
      status: 'failed',
      message: this.reason,
      result: null
    }
  }
}
