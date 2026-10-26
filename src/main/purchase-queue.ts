import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync
} from 'node:fs'
import { copyFile, open, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { DocumentExtractionClient } from './document-extraction-client'
import { isQueueBusiness, type QueueBusinessId } from '../shared/purchase-queue'
import type { ErpAutofillResult } from '../shared/erp'
import type { OcrDocumentResult, OcrProgress } from '../shared/ocr'
import type {
  PurchaseQueueImportResult, PurchaseQueueTask, PurchaseQueueTaskDetail
} from '../shared/purchase-queue'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SOURCE = /^source\.(pdf|png|jpg|jpeg|bmp|tif|tiff|webp)$/
const EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp'])
const RECOGNITION = new Set(['queued', 'recognizing', 'ready', 'failed', 'paused', 'cancelled'])
const USAGE = new Set(['available', 'filling', 'partial', 'filled', 'uncertain'])
const STAGES = new Set(['queued', 'reading', 'rendering', 'recognizing', 'extracting', 'completed'])

interface StoredTask {
  version: 2
  sourceName: string
  task: PurchaseQueueTaskDetail
}
interface OwnerQueue {
  tasks: Map<string, StoredTask>
  active: boolean
  removed: boolean
}
interface RunningTask {
  owner: string
  taskId: string
  controller: AbortController
  valid: boolean
}
type Progress = Omit<OcrProgress, 'sessionId' | 'businessId'>

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

// A cached payload must be safe for both the review UI and the autofill adapter.
function validResult(value: unknown, businessId: QueueBusinessId): value is OcrDocumentResult {
  if (!object(value) || value.businessId !== businessId || typeof value.fileName !== 'string'
    || typeof value.engine !== 'string' || typeof value.modelVersion !== 'string'
    || !['pageCount', 'blockCount', 'ocrPages', 'elapsedMs', 'coveragePercent'].every(key => finite(value[key]))
    || !strings(value.warnings) || !Array.isArray(value.pages)) return false
  if (!value.pages.every(page => object(page) && finite(page.pageNumber) && typeof page.text === 'string'
    && ['pi-ocr', 'skipped-user', 'skipped-error'].includes(String(page.source)) && Array.isArray(page.blocks)
    && page.blocks.every(block => object(block) && typeof block.text === 'string' && finite(block.confidence)
      && (block.boundingBox === null || (Array.isArray(block.boundingBox) && block.boundingBox.every(finite)))))) return false
  const extraction = value.extractedData
  if (extraction === null) return true
  if (!object(extraction) || extraction.documentType !== businessId || !object(extraction.header)
    || !Array.isArray(extraction.items) || !object(extraction.fieldEvidence)
    || !finite(extraction.recognizedFieldCount) || !strings(extraction.missingRecommendedFields)
    || !strings(extraction.reviewRequired) || typeof extraction.readyForAutofill !== 'boolean') return false
  const headerStrings = businessId === 'goods-receipt' ? ['supplierName', 'departureDate', 'carrierName',
    'transportMethod', 'receiptDateTime', 'transportProcessTemperatureStatus', 'transportVehicle', 'departurePlace',
    'departureDateTime', 'receiptDateTimeDetail', 'receiptRemark', 'goodsAccountConsistency', 'deliveryNoteCompliance',
    'enclosedVehicle', 'logisticsVoucherCompliance', 'transportTimeLimitStatus'] : ['supplierName', 'sourceOrderNumber', 'invoiceDate', 'departureDate', 'customerName',
    'receivingAddress', 'carrierName', 'transportMethod', 'coldChain', 'receiptRemark', 'remark', 'paymentMethod', 'groupName']
  const header = extraction.header
  const headerNumbers = businessId === 'goods-receipt' ? ['surfaceTemperature', 'actualTransportHours'] : ['transportTimeLimit']
  if (!headerStrings.every(key => nullableString(header[key]))
    || !headerNumbers.every(key => header[key] === null || finite(header[key]))) return false
  if (!Object.values(extraction.fieldEvidence).every(item => object(item) && Array.isArray(item.sourcePages)
    && item.sourcePages.every(finite) && finite(item.confidence) && typeof item.reviewRequired === 'boolean')) return false
  const itemStrings = businessId === 'goods-receipt' ? ['specification', 'manufacturer', 'marketingAuthorizationHolder',
    'unit', 'batchNumber', 'productionDate', 'expiryDate', 'approvalNumber', 'dosageForm', 'remark'] : ['specification', 'dosageForm', 'manufacturer', 'origin', 'approvalNumber',
    'marketingAuthorizationHolder', 'unit', 'batchNumber', 'productionDate', 'expiryDate', 'qualityStatus']
  const itemNumbers = businessId === 'goods-receipt' ? ['packageQuantity', 'arrivalQuantity', 'receiptQuantity',
    'unitPrice', 'amount', 'pieceRatio'] : ['packageQuantity', 'quantity', 'taxIncludedUnitPrice', 'taxIncludedAmount']
  return extraction.items.every(item => object(item) && typeof item.productName === 'string'
    && itemStrings.every(key => nullableString(item[key]))
    && itemNumbers.every(key => item[key] === null || finite(item[key]))
    && Array.isArray(item.sourcePages) && item.sourcePages.every(finite))
}

function validFill(value: unknown): value is ErpAutofillResult {
  return object(value) && ['filled', 'partial', 'wrong-page', 'unavailable', 'failed'].includes(String(value.status))
    && typeof value.message === 'string' && finite(value.filledHeaderFields) && finite(value.filledDetailRows)
    && strings(value.skippedFields)
}

function validStored(value: unknown, taskId: string): value is StoredTask {
  if (!object(value) || value.version !== 2 || typeof value.sourceName !== 'string' || !SOURCE.test(value.sourceName)
    || !object(value.task)) return false
  const task = value.task
  return isQueueBusiness(task.businessId) && task.taskId === taskId && typeof task.batchId === 'string' && UUID.test(task.batchId)
    && ['sequence', 'createdAt', 'updatedAt', 'revision'].every(key => finite(task[key]))
    && typeof task.fileName === 'string' && typeof task.message === 'string'
    && RECOGNITION.has(String(task.recognitionStatus)) && USAGE.has(String(task.usageStatus))
    && nullableString(task.supplierName) && nullableString(task.sourceOrderNumber) && nullableString(task.boundPageId)
    && typeof task.readyForAutofill === 'boolean' && (task.lastFill === null || validFill(task.lastFill))
    && (task.result === null || validResult(task.result, task.businessId))
    && (task.recognitionStatus !== 'ready' || task.result !== null)
    && (task.progress === null || (object(task.progress) && STAGES.has(String(task.progress.stage))
      && finite(task.progress.current) && finite(task.progress.total) && typeof task.progress.message === 'string'))
}

function message(error: unknown): string {
  const fileErrors: Record<string, string> = {
    ENOENT: '文件不存在或已被移动，请重新添加票据',
    EACCES: '没有权限访问本地文件，请检查目录权限',
    EPERM: '本地文件访问被拒绝，请检查目录权限或文件占用',
    ENOSPC: '本地磁盘空间不足，请清理后重试',
    EBUSY: '本地文件正被占用，请稍后重试',
    ENOTDIR: '本地缓存目录不可用，请检查后重试',
    EISDIR: '所选内容不是普通文件，请重新选择',
    EROFS: '本地缓存目录不可写，请检查目录权限',
    EIO: '本地文件读写失败，请检查磁盘后重试',
    EMFILE: '打开的本地文件过多，请稍后重试',
    ENFILE: '打开的本地文件过多，请稍后重试',
    ENAMETOOLONG: '文件路径过长，请移动文件后重试',
    EEXIST: '本地缓存文件冲突，请重试'
  }
  if (object(error) && typeof error.code === 'string' && fileErrors[error.code]) return fileErrors[error.code]
  return error instanceof Error ? error.message : String(error)
}

export class PurchaseQueueManager {
  private readonly owners = new Map<string, OwnerQueue>()
  private readonly running = new Map<string, RunningTask>()
  private readonly fills = new Map<string, string>()
  private readonly root: string
  private readonly concurrency: number
  private readonly maxUploadBytes: number
  private lastOwner = ''
  private stopped = false
  private pumping = false

  constructor(
    root: string,
    private readonly client: DocumentExtractionClient,
    private readonly onChanged: (owner: string) => void,
    options: { concurrency?: number; maxUploadBytes?: number } = {}
  ) {
    this.root = resolve(root)
    this.concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 2)))
    this.maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 * 1024
    mkdirSync(this.root, { recursive: true })
  }

  list(owner: string): PurchaseQueueTask[] {
    return [...this.load(owner).tasks.values()]
      .sort((a, b) => a.task.createdAt - b.task.createdAt || a.task.sequence - b.task.sequence)
      .map(({ task }) => {
        const { result: _result, ...summary } = task
        return structuredClone(summary)
      })
  }

  get(owner: string, taskId: string): PurchaseQueueTaskDetail {
    return structuredClone(this.find(owner, taskId).task)
  }

  sourcePath(owner: string, taskId: string): string {
    const record = this.find(owner, taskId)
    const path = join(this.taskDirectory(owner, taskId), record.sourceName)
    try {
      const metadata = lstatSync(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('missing source')
    } catch { throw new Error('缓存原图不存在，请重新添加票据') }
    return path
  }

  async enqueue(owner: string, paths: string[], businessId: QueueBusinessId = 'purchase-order'): Promise<PurchaseQueueImportResult> {
    if (this.stopped) throw new Error('客户端正在退出')
    if (!isQueueBusiness(businessId)) throw new Error('该业务不支持批量识别')
    this.activate(owner)
    const queue = this.load(owner)
    const batchId = randomUUID()
    const imported: PurchaseQueueImportResult = { added: [], errors: [] }
    for (const [index, filePath] of paths.entries()) {
      if (queue.removed || this.stopped) {
        imported.errors.push({ fileName: basename(filePath), message: '导入已停止' })
        continue
      }
      let directory: string | null = null
      try {
        const extension = extname(filePath).toLowerCase()
        if (!EXTENSIONS.has(extension)) throw new Error('请选择 PDF 或支持的图片格式')
        const metadata = await stat(filePath)
        if (!metadata.isFile() || metadata.size <= 0) throw new Error('文件为空或不是普通文件')
        if (metadata.size > this.maxUploadBytes) throw new Error(`文件超过 ${Math.round(this.maxUploadBytes / 1024 / 1024)} MB 限额`)
        const taskId = randomUUID()
        directory = this.taskDirectory(owner, taskId)
        mkdirSync(directory, { recursive: true })
        const sourceName = `source${extension}`
        const destination = join(directory, sourceName)
        await copyFile(filePath, destination)
        await this.validateSource(destination, extension)
        if (queue.removed || this.stopped) throw new Error('导入已停止')
        const timestamp = Date.now()
        const task: PurchaseQueueTaskDetail = {
          businessId, taskId, batchId, sequence: index + 1, fileName: basename(filePath), createdAt: timestamp,
          updatedAt: timestamp, revision: 0, recognitionStatus: queue.active ? 'queued' : 'paused',
          usageStatus: 'available', progress: null, message: queue.active ? '等待识别' : '已暂停，登录后继续识别',
          supplierName: null, sourceOrderNumber: null, readyForAutofill: false,
          boundPageId: null, lastFill: null, result: null
        }
        this.save(owner, { version: 2, sourceName, task })
        imported.added.push(taskId)
        directory = null
        this.pump()
      } catch (error) {
        if (directory) this.deleteDirectory(directory)
        imported.errors.push({ fileName: basename(filePath), message: message(error) })
      }
    }
    return imported
  }

  activate(owner: string): void {
    if (this.stopped) return
    const queue = this.load(owner)
    queue.active = true
    for (const record of queue.tasks.values()) {
      if (record.task.recognitionStatus === 'paused') this.change(owner, record, {
        recognitionStatus: 'queued', message: '等待识别'
      })
    }
    this.pump()
  }

  suspend(owner: string): void {
    const queue = this.owners.get(owner)
    if (!queue) return
    queue.active = false
    for (const record of queue.tasks.values()) {
      if (['queued', 'recognizing'].includes(record.task.recognitionStatus)) {
        this.invalidate(owner, record.task.taskId)
        this.change(owner, record, { recognitionStatus: 'paused', progress: null, message: '已暂停，登录后继续识别' })
      }
      if (record.task.usageStatus === 'filling') this.change(owner, this.find(owner, record.task.taskId), {
        usageStatus: 'uncertain', message: '代填中断，请核对 ERP 后重试'
      })
    }
  }

  retry(owner: string, taskId: string): void {
    const record = this.find(owner, taskId)
    const incomplete = record.task.recognitionStatus === 'ready' && !record.task.readyForAutofill
      && record.task.usageStatus === 'available' && !record.task.boundPageId
    if (!incomplete && !['failed', 'cancelled', 'paused'].includes(record.task.recognitionStatus)) throw new Error('当前票据无需重新识别')
    const queue = this.load(owner)
    queue.active = true
    this.change(owner, record, { recognitionStatus: 'queued', readyForAutofill: false, progress: null, message: '等待重新识别' })
    this.pump()
  }

  cancel(owner: string, taskId: string): void {
    const record = this.find(owner, taskId)
    if (!['queued', 'recognizing', 'paused'].includes(record.task.recognitionStatus)) return
    this.change(owner, record, { recognitionStatus: 'cancelled', progress: null, message: '已取消识别，可稍后重试' })
    this.invalidate(owner, taskId)
  }

  remove(owner: string, taskId: string): void {
    const record = this.find(owner, taskId)
    if (record.task.usageStatus === 'filling' || record.task.boundPageId || this.fills.has(this.jobKey(owner, taskId))) {
      throw new Error('票据仍绑定单据页或正在代填，请先关闭该单据并等待代填结束')
    }
    this.invalidate(owner, taskId)
    this.deleteDirectory(this.taskDirectory(owner, taskId))
    this.load(owner).tasks.delete(taskId)
    this.emit(owner)
  }

  resetUsage(owner: string, taskId: string): void {
    const record = this.find(owner, taskId)
    if (record.task.boundPageId || record.task.usageStatus === 'filling' || this.fills.has(this.jobKey(owner, taskId))) {
      throw new Error('请先关闭当前绑定的 ERP 单据页并等待代填结束')
    }
    if (record.task.recognitionStatus !== 'ready') throw new Error('票据尚未完成识别')
    this.change(owner, record, { usageStatus: 'available', message: '已放回待处理，请确认没有重复制单' })
  }

  retainPages(owner: string, pageIds: string[]): void {
    const openPages = new Set(pageIds)
    for (const record of this.load(owner).tasks.values()) {
      if (record.task.boundPageId && !openPages.has(record.task.boundPageId)) this.change(owner, record, {
        boundPageId: null,
        ...(record.task.usageStatus === 'filling' ? {
          usageStatus: 'uncertain' as const, message: '代填时单据页已关闭，请核对 ERP'
        } : {})
      })
    }
  }

  beginFill(owner: string, taskId: string, pageId: string, businessId: QueueBusinessId = 'purchase-order'): PurchaseQueueTaskDetail {
    if (!pageId || this.stopped) throw new Error('当前单据页不可用')
    const record = this.find(owner, taskId)
    const { task } = record
    if (task.businessId !== businessId) throw new Error('识别结果与当前业务不一致，已拒绝代填')
    if (task.recognitionStatus !== 'ready' || !task.readyForAutofill || !task.result?.extractedData?.readyForAutofill) {
      throw new Error('该票据尚未具备代填条件，请先复核识别结果')
    }
    if (task.usageStatus === 'filling' || this.fills.has(this.jobKey(owner, taskId))) throw new Error('该票据正在代填，请勿重复操作')
    if (task.boundPageId && task.boundPageId !== pageId) throw new Error('该票据已绑定其他单据页')
    if (task.usageStatus !== 'available' && task.boundPageId !== pageId) throw new Error('该票据已有代填记录，请先核对并放回待处理')
    if ([...this.load(owner).tasks.values()].some(other => other.task.taskId !== taskId && other.task.boundPageId === pageId)) {
      throw new Error('当前单据页已绑定另一张票据，请新建对应业务的单据')
    }
    this.change(owner, record, { usageStatus: 'filling', boundPageId: pageId, message: '正在代填' })
    this.fills.set(this.jobKey(owner, taskId), pageId)
    return this.get(owner, taskId)
  }

  finishFill(owner: string, taskId: string, result: ErpAutofillResult): void {
    const key = this.jobKey(owner, taskId)
    const pageId = this.fills.get(key)
    const queue = this.owners.get(owner)
    const record = queue?.tasks.get(taskId)
    // Closing a page or signing out invalidates an in-flight fill completion.
    if (!record || !pageId || record.task.usageStatus !== 'filling' || record.task.boundPageId !== pageId) {
      this.fills.delete(key)
      return
    }
    if (!validFill(result)) throw new Error('代填返回了无效结果')
    const usageStatus = result.status === 'filled' ? 'filled'
      : result.status === 'partial' || result.filledHeaderFields > 0 || result.filledDetailRows > 0 ? 'partial' : 'uncertain'
    try {
      this.change(owner, record, {
        usageStatus, lastFill: structuredClone(result),
        message: usageStatus === 'filled' ? '已代填，请在 ERP 核对并保存' : result.message
      })
    } catch (error) {
      // The ERP may already contain data. Keep the durable filling intent for restart,
      // and expose an uncertain state in this process so the user can recover after disk repair.
      record.task.usageStatus = 'uncertain'
      record.task.revision += 1
      record.task.updatedAt = Date.now()
      record.task.message = '代填状态写入本地失败，请核对 ERP 后再处理'
      this.emit(owner)
      throw error
    } finally { this.fills.delete(key) }
  }

  shutdown(): void {
    if (this.stopped) return
    this.stopped = true
    for (const owner of this.owners.keys()) {
      try { this.suspend(owner) } catch { /* Restart also recovers interrupted states. */ }
    }
    for (const job of this.running.values()) { job.valid = false; job.controller.abort() }
  }

  removeOwner(owner: string): void {
    const queue = this.owners.get(owner)
    if (queue) { queue.active = false; queue.removed = true }
    for (const job of this.running.values()) if (job.owner === owner) { job.valid = false; job.controller.abort() }
    this.deleteDirectory(this.ownerDirectory(owner))
    this.owners.delete(owner)
    this.emit(owner)
  }

  private ownerDirectory(owner: string): string {
    if (!owner) throw new Error('缺少票据队列账号身份')
    return join(this.root, createHash('sha256').update(owner).digest('hex'))
  }

  private taskDirectory(owner: string, taskId: string): string {
    if (!UUID.test(taskId)) throw new Error('无效票据编号')
    return join(this.ownerDirectory(owner), taskId)
  }

  private deleteDirectory(directory: string): void {
    const target = resolve(directory)
    if (!target.startsWith(this.root + sep) || target === this.root) throw new Error('拒绝清理缓存目录外的路径')
    try { rmSync(target, { recursive: true, force: true }) }
    catch (error) { throw new Error(message(error)) }
  }

  private load(owner: string): OwnerQueue {
    const loaded = this.owners.get(owner)
    if (loaded) return loaded
    const queue: OwnerQueue = { tasks: new Map(), active: false, removed: false }
    const directory = this.ownerDirectory(owner)
    if (!existsSync(directory)) { this.owners.set(owner, queue); return queue }
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('无效的采购缓存目录')
    this.owners.set(owner, queue)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      try {
        const path = join(directory, entry.name, 'task.json')
        const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
        // Version 1 only contained purchase orders; migrate without re-recognition.
        if (object(record) && record.version === 1 && object(record.task) && record.task.businessId === undefined) {
          record.version = 2
          record.task.businessId = 'purchase-order'
        }
        if (!validStored(record, entry.name)) throw new Error('无效的票据缓存内容')
        const source = join(directory, entry.name, record.sourceName)
        if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new Error('缓存原图缺失')
        const task = record.task
        if (task.recognitionStatus === 'recognizing' || task.recognitionStatus === 'queued') {
          task.recognitionStatus = 'paused'; task.progress = null; task.message = '上次识别中断，登录后继续识别'
        }
        if (task.usageStatus === 'filling') {
          task.usageStatus = 'uncertain'; task.message = '上次代填中断，请核对 ERP 后再处理'
        }
        task.boundPageId = null
        const extraction = task.result?.extractedData
        task.readyForAutofill = task.recognitionStatus === 'ready' && extraction?.readyForAutofill === true
        task.supplierName = extraction && isQueueBusiness(extraction.documentType) && 'supplierName' in extraction.header ? extraction.header.supplierName : null
        task.sourceOrderNumber = extraction?.documentType === 'purchase-order' ? extraction.header.sourceOrderNumber : null
        this.save(owner, record, false)
      } catch {
        // Keep corrupt input for inspection and isolate only this task.
        const source = join(directory, entry.name)
        try { renameSync(source, join(directory, `${entry.name}.corrupt-${Date.now()}`)) } catch { /* Leave it untouched if locked. */ }
      }
    }
    return queue
  }

  private find(owner: string, taskId: string): StoredTask {
    if (!UUID.test(taskId)) throw new Error('无效票据编号')
    const record = this.load(owner).tasks.get(taskId)
    if (!record) throw new Error('票据不存在或不属于当前账号')
    return record
  }

  private save(owner: string, record: StoredTask, emit = true): void {
    const directory = this.taskDirectory(owner, record.task.taskId)
    const temporary = join(directory, `task-${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx')
      writeFileSync(descriptor, JSON.stringify(record), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor); descriptor = undefined
      renameSync(temporary, join(directory, 'task.json'))
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      rmSync(temporary, { force: true })
      throw new Error(message(error))
    }
    this.owners.get(owner)!.tasks.set(record.task.taskId, record)
    if (emit) this.emit(owner)
  }

  private change(owner: string, record: StoredTask, patch: Partial<PurchaseQueueTaskDetail>): void {
    this.save(owner, { ...record, task: {
      ...record.task, ...patch, updatedAt: Date.now(), revision: record.task.revision + 1
    } })
  }

  private emit(owner: string): void {
    try { this.onChanged(owner) } catch { /* A closed renderer cannot invalidate a saved task. */ }
  }

  private jobKey(owner: string, taskId: string): string { return `${owner}\0${taskId}` }

  private invalidate(owner: string, taskId: string): void {
    const job = this.running.get(this.jobKey(owner, taskId))
    if (job) { job.valid = false; job.controller.abort() }
  }

  private pump(): void {
    if (this.stopped || this.pumping) return
    this.pumping = true
    try {
      while (this.running.size < this.concurrency) {
        const owners = [...this.owners.keys()]
        const offset = (owners.indexOf(this.lastOwner) + 1) % (owners.length || 1)
        let picked: { owner: string; record: StoredTask } | null = null
        for (let step = 0; step < owners.length; step++) {
          const owner = owners[(offset + step) % owners.length]
          const queue = this.owners.get(owner)!
          if (!queue.active || queue.removed) continue
          const record = [...queue.tasks.values()]
            .filter(candidate => candidate.task.recognitionStatus === 'queued'
              && !this.running.has(this.jobKey(owner, candidate.task.taskId)))
            .sort((a, b) => a.task.createdAt - b.task.createdAt || a.task.sequence - b.task.sequence)[0]
          if (record) { picked = { owner, record }; break }
        }
        if (!picked) break
        this.lastOwner = picked.owner
        const job: RunningTask = {
          owner: picked.owner, taskId: picked.record.task.taskId, controller: new AbortController(), valid: true
        }
        this.running.set(this.jobKey(job.owner, job.taskId), job)
        void this.run(job)
      }
    } finally { this.pumping = false }
  }

  private current(job: RunningTask): StoredTask | undefined {
    if (!job.valid || this.stopped) return undefined
    const queue = this.owners.get(job.owner)
    return queue?.active && !queue.removed ? queue.tasks.get(job.taskId) : undefined
  }

  private async run(job: RunningTask): Promise<void> {
    const { owner, taskId } = job
    try {
      const record = this.current(job)
      if (!record) return
      this.change(owner, record, { recognitionStatus: 'recognizing', message: '正在识别' })
      let lastProgressAt = 0
      const response = await this.client.extractDocument(this.sourcePath(owner, taskId), (progress: Progress) => {
        const current = this.current(job)
        if (!current || Date.now() - lastProgressAt < 200) return
        lastProgressAt = Date.now()
        try { this.change(owner, current, { progress: structuredClone(progress), message: progress.message }) }
        catch { /* The final result still has to pass durable persistence before becoming ready. */ }
      }, { businessId: record.task.businessId, excludedPages: [], signal: job.controller.signal })
      const current = this.current(job)
      if (!current) return
      if (response.status !== 'completed') {
        this.change(owner, current, {
          recognitionStatus: response.status === 'cancelled' ? 'cancelled' : 'failed',
          progress: null, message: response.message || '识别失败，请重试'
        })
        return
      }
      if (!validResult(response.result, current.task.businessId)) throw new Error('识别结果格式无效或与任务业务不匹配')
      const result = structuredClone(response.result)
      result.fileName = current.task.fileName
      const extraction = result.extractedData
      if (extraction && (extraction.documentType === 'unit-initial-approval' || extraction.documentType !== current.task.businessId)) {
        throw new Error('识别结果业务类型不匹配')
      }
      this.change(owner, current, {
        recognitionStatus: 'ready', result, progress: null,
        readyForAutofill: extraction?.readyForAutofill === true,
        supplierName: extraction?.header.supplierName ?? null,
        sourceOrderNumber: extraction?.documentType === 'purchase-order' ? extraction.header.sourceOrderNumber : null,
        message: extraction?.readyForAutofill ? '识别完成，可以复核并代填' : '识别完成，需要核对字段'
      })
    } catch (error) {
      const current = this.current(job)
      if (current) {
        try { this.change(owner, current, { recognitionStatus: 'failed', progress: null, message: message(error) }) }
        catch {
          // Never publish an unsaved recognition result as ready.
          current.task.recognitionStatus = 'failed'
          current.task.readyForAutofill = false
          current.task.revision += 1
          current.task.updatedAt = Date.now()
          current.task.message = `本地缓存写入失败：${message(error)}`
          this.emit(owner)
        }
      }
    } finally {
      // Abort does not release a slot until the underlying request has actually settled.
      this.running.delete(this.jobKey(owner, taskId))
      this.pump()
    }
  }

  private async validateSource(path: string, extension: string): Promise<void> {
    const metadata = await stat(path)
    if (!metadata.size || metadata.size > this.maxUploadBytes) throw new Error('复制后的文件为空或超过大小限额')
    const handle = await open(path, 'r')
    try {
      const bytes = Buffer.alloc(12)
      const { bytesRead } = await handle.read(bytes, 0, 12, 0)
      const ascii = bytes.toString('ascii')
      const valid = extension === '.pdf' ? ascii.startsWith('%PDF-')
        : extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ['.jpg', '.jpeg'].includes(extension) ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            : extension === '.bmp' ? ascii.startsWith('BM')
              : extension === '.webp' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
                : bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
      if (bytesRead < 4 || !valid) throw new Error('文件内容与扩展名不匹配或文件已损坏')
    } finally { await handle.close() }
  }
}
