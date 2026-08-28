import { loadPiAgentConfig } from './agent/config'
import { PiDocumentClient } from './agent/pi-document-client'
import {
  type DocumentExtractionClient,
  UnavailableDocumentExtractionClient
} from './document-extraction-client'

export function createDocumentExtractionClient(): DocumentExtractionClient {
  try {
    return new PiDocumentClient(loadPiAgentConfig())
  } catch (error) {
    const message = error instanceof Error ? error.message : '文档处理运行时初始化失败'
    console.error(message)
    return new UnavailableDocumentExtractionClient(message)
  }
}
