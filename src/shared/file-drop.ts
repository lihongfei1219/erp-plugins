import type { BusinessId } from './business'

export const FILE_DROP_IPC = {
  dropped: 'files:dropped', feedback: 'files:feedback'
} as const

export type FileDropFeedback = { kind: 'error'; message: string } | {
  kind: 'ready'; token: string; businessId: BusinessId; pageId: string; count: number
}

export interface FileDropApi {
  onDrop: (listener: (value: FileDropFeedback) => void) => () => void
}
