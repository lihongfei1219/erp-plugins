import { ipcRenderer, webUtils } from 'electron'
import { FILE_DROP_IPC } from '../shared/file-drop'

// No filesystem API is exposed to either renderer. Only genuine OS file drops
// carry paths, obtained inside the isolated preload (File.path is not supported).
export function installFileDrop(includeFrames = false): void {
  const attached = new WeakSet<Document>()
  const attach = (document: Document): void => {
    if (attached.has(document)) return
    attached.add(document)
    let badge: HTMLDivElement | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = (): void => { badge?.remove(); badge = null; clearTimeout(timer) }
    const show = (): void => {
      if (!badge) {
        badge = document.createElement('div')
        badge.textContent = '松开文件，导入当前业务 · 支持图片 / PDF'
        badge.setAttribute('data-file-drop-hint', '')
        badge.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;padding:14px 22px;border:2px dashed #2d63df;border-radius:12px;background:#eff5ff;color:#174dbf;font:15px sans-serif;box-shadow:0 4px 24px #0002;white-space:nowrap'
        document.documentElement.appendChild(badge)
      }
      clearTimeout(timer)
      timer = setTimeout(clear, 1200)
    }
    const isFiles = (event: DragEvent): boolean => Boolean(event.dataTransfer &&
      Array.from(event.dataTransfer.types).includes('Files'))
    const over = (event: DragEvent): void => {
      if (!isFiles(event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      show()
    }
    document.addEventListener('dragenter', over, true)
    document.addEventListener('dragover', over, true)
    document.addEventListener('dragleave', event => { if (!event.relatedTarget) clear() }, true)
    document.addEventListener('drop', event => {
      if (!isFiles(event)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      clear()
      if (!event.isTrusted) return
      const paths = Array.from(event.dataTransfer?.files ?? []).map(file => {
        try { return webUtils.getPathForFile(file) } catch { return '' }
      }).filter(Boolean)
      ipcRenderer.send(FILE_DROP_IPC.dropped, paths)
    }, true)
    if (includeFrames) {
      const scan = (): void => {
        for (const frame of document.querySelectorAll('iframe, frame')) {
          try {
            const child = (frame as HTMLIFrameElement).contentDocument
            if (child) attach(child)
          } catch { /* Cross-origin frames cannot import into the trusted ERP. */ }
        }
      }
      document.addEventListener('load', scan, true)
      new MutationObserver(scan).observe(document, { childList: true, subtree: true })
      scan()
    }
  }
  attach(document)
}
