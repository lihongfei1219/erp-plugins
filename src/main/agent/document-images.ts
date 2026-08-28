import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { getDocument, type PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs'

const PDF_RENDER_SCALE = 2
const MAX_IMAGE_DIMENSION = 2600
const MAX_SOURCE_PIXELS = 80_000_000
const JPEG_QUALITY = 88
const PREVIEW_JPEG_QUALITY = 75
const PREVIEW_MAX_DIMENSION = 720
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'])

export interface PreparedPageImage {
  data: string
  mimeType: 'image/jpeg'
  width: number
  height: number
}

export interface PreparedDocument {
  pageCount: number
  renderPage(pageNumber: number, options?: RenderPageOptions): Promise<PreparedPageImage>
  dispose(): Promise<void>
}

export interface RenderPageOptions {
  maxDimension?: number
  jpegQuality?: number
}

export interface LocalDocumentPreviewPage {
  pageNumber: number
  thumbnailDataUrl: string
}

function targetDimensions(
  width: number,
  height: number,
  maxDimension = MAX_IMAGE_DIMENSION
): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

async function encodeCanvas(
  canvas: Canvas,
  jpegQuality = JPEG_QUALITY
): Promise<PreparedPageImage> {
  const buffer = await canvas.encode('jpeg', jpegQuality)
  return {
    data: buffer.toString('base64'),
    mimeType: 'image/jpeg',
    width: canvas.width,
    height: canvas.height
  }
}

async function preparePdf(contents: Buffer, maxPages: number): Promise<PreparedDocument> {
  const loadingTask: PDFDocumentLoadingTask = getDocument({
    data: new Uint8Array(contents),
    useSystemFonts: true
  })
  const document = await loadingTask.promise

  if (document.numPages > maxPages) {
    await loadingTask.destroy()
    throw new Error(`PDF 共 ${document.numPages} 页，超过当前 ${maxPages} 页限制`)
  }

  return {
    pageCount: document.numPages,
    async renderPage(pageNumber, options = {}): Promise<PreparedPageImage> {
      if (pageNumber < 1 || pageNumber > document.numPages) {
        throw new Error(`PDF 页码 ${pageNumber} 超出范围`)
      }
      const page = await document.getPage(pageNumber)
      const sourceViewport = page.getViewport({ scale: PDF_RENDER_SCALE })
      const dimensions = targetDimensions(
        sourceViewport.width,
        sourceViewport.height,
        options.maxDimension
      )
      const scale = PDF_RENDER_SCALE * (dimensions.width / sourceViewport.width)
      const viewport = page.getViewport({ scale })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)

      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport
      }).promise
      page.cleanup()
      return encodeCanvas(canvas, options.jpegQuality)
    },
    async dispose(): Promise<void> {
      await loadingTask.destroy()
    }
  }
}

async function prepareImage(contents: Buffer): Promise<PreparedDocument> {
  const image = await loadImage(contents)
  if (image.width * image.height > MAX_SOURCE_PIXELS) {
    throw new Error('图片像素总量超过 8000 万限制')
  }
  const dimensions = targetDimensions(image.width, image.height)

  return {
    pageCount: 1,
    async renderPage(pageNumber, options = {}): Promise<PreparedPageImage> {
      if (pageNumber !== 1) throw new Error('图片文件只有 1 页')
      const target = targetDimensions(image.width, image.height, options.maxDimension)
      const canvas = createCanvas(target.width, target.height)
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      return encodeCanvas(canvas, options.jpegQuality)
    },
    async dispose(): Promise<void> {}
  }
}

export async function prepareDocument(
  filePath: string,
  maxUploadBytes: number,
  maxPages: number
): Promise<PreparedDocument> {
  const fileStat = await stat(filePath)
  if (!fileStat.isFile()) throw new Error('选择的路径不是文件')
  if (fileStat.size <= 0) throw new Error('文件内容为空')
  if (fileStat.size > maxUploadBytes) {
    throw new Error(`文件大小超过 ${Math.round(maxUploadBytes / 1024 / 1024)} MB 限制`)
  }

  const extension = extname(filePath).toLowerCase()
  if (extension !== '.pdf' && !IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`暂不支持 ${extension || '未知格式'} 文件`)
  }

  const contents = await readFile(filePath)
  return extension === '.pdf' ? preparePdf(contents, maxPages) : prepareImage(contents)
}

export async function createLocalDocumentPreview(
  filePath: string,
  maxUploadBytes: number,
  maxPages: number,
  onProgress?: (current: number, total: number) => void
): Promise<{ pageCount: number; pages: LocalDocumentPreviewPage[] }> {
  const document = await prepareDocument(filePath, maxUploadBytes, maxPages)
  try {
    const pages: LocalDocumentPreviewPage[] = []
    for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
      onProgress?.(pageNumber - 1, document.pageCount)
      const thumbnail = await document.renderPage(pageNumber, {
        maxDimension: PREVIEW_MAX_DIMENSION,
        jpegQuality: PREVIEW_JPEG_QUALITY
      })
      pages.push({
        pageNumber,
        thumbnailDataUrl: `data:${thumbnail.mimeType};base64,${thumbnail.data}`
      })
      onProgress?.(pageNumber, document.pageCount)
    }
    return { pageCount: document.pageCount, pages }
  } finally {
    await document.dispose()
  }
}
