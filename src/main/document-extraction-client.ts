import type {
  DocumentExtractionOptions,
  OcrClientResult,
  OcrProgress
} from '../shared/ocr'

export interface DocumentExtractionClient {
  extractDocument(
    filePath: string,
    onProgress: (progress: Omit<OcrProgress, 'sessionId' | 'businessId'>) => void,
    options: DocumentExtractionOptions
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
