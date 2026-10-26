<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BUSINESS_DEFINITIONS, type PurchaseOrderExtraction, type GoodsReceiptExtraction } from '../../shared/business'
import { isQueueBusiness } from '../../shared/purchase-queue'
import type { ErpState } from '../../shared/erp'
import type {
  PurchaseQueuePreview, PurchaseQueueTask, PurchaseQueueTaskDetail
} from '../../shared/purchase-queue'

const props = defineProps<{ erpState: ErpState }>()
const api = window.desktop.purchaseQueue
const tasks = ref<PurchaseQueueTask[]>([])
const selectedId = ref<string | null>(null)
const detail = ref<PurchaseQueueTaskDetail | null>(null)
const loadingDetail = ref(false)
const importing = ref(false)
const busy = ref<Record<string, string>>({})
const error = ref('')
const notice = ref('')
const importErrors = ref<{ fileName: string; message: string }[]>([])
const resetCandidate = ref<string | null>(null)
const removeCandidate = ref<string | null>(null)
const preview = ref<PurchaseQueuePreview | null>(null)
const previewBusy = ref(false)
const zoomPage = ref<PurchaseQueuePreview['pages'][number] | null>(null)
const previewDialog = ref<HTMLElement | null>(null)
const previewButton = ref<HTMLButtonElement | null>(null)
const selectedByPage = new Map<string, string>()
let disposed = false
let mounted = false
let accountEpoch = 0
let detailVersion = 0
let refreshRequested = false
let refreshRunning = false
let unsubscribe: (() => void) | undefined
let previewVersion = 0
let previewOwned = false
let previewTail: Promise<void> = Promise.resolve()

const accountId = computed(() => props.erpState.account?.id ?? null)
const signedIn = computed(() => props.erpState.account?.status === 'signed-in')
const businessId = computed(() => {
  const id = props.erpState.currentPage?.businessId
  return isQueueBusiness(id) ? id : null
})
const isQueuePage = computed(() => businessId.value !== null)
const businessName = computed(() => businessId.value ? BUSINESS_DEFINITIONS[businessId.value].name : '采购与收货')
const visibleTasks = computed(() => businessId.value ? tasks.value.filter(task => task.businessId === businessId.value) : tasks.value)
const pageId = computed(() => isQueuePage.value ? props.erpState.currentPage?.pageId ?? null : null)
const pageReady = computed(() => Boolean(signedIn.value && pageId.value &&
  props.erpState.currentPage?.supported && props.erpState.currentPage.isNew))
const selectedTask = computed(() => visibleTasks.value.find(task => task.taskId === selectedId.value) ?? null)
const boundTask = computed(() => pageId.value
  ? visibleTasks.value.find(task => task.boundPageId === pageId.value) ?? null : null)
const extraction = computed<PurchaseOrderExtraction | GoodsReceiptExtraction | null>(() => {
  const result = detail.value?.taskId === selectedId.value ? detail.value.result?.extractedData : null
  return result && result.documentType !== 'unit-initial-approval' && result.documentType === businessId.value ? result : null
})
const filling = computed(() => tasks.value.some(task => task.usageStatus === 'filling') ||
  Object.values(busy.value).includes('fill'))
const nextTask = computed(() => visibleTasks.value.find(task => task.taskId !== selectedId.value &&
  task.recognitionStatus === 'ready' && task.readyForAutofill && task.usageStatus === 'available' && !task.boundPageId) ?? null)
const counts = computed(() => ({
  total: visibleTasks.value.length,
  waiting: visibleTasks.value.filter(task => task.recognitionStatus === 'queued').length,
  running: visibleTasks.value.filter(task => task.recognitionStatus === 'recognizing').length,
  ready: visibleTasks.value.filter(task => task.recognitionStatus === 'ready' && task.usageStatus === 'available' &&
    task.readyForAutofill && !task.boundPageId).length,
  review: visibleTasks.value.filter(task => task.recognitionStatus === 'ready' && task.usageStatus === 'available' &&
    !task.readyForAutofill).length,
  failed: visibleTasks.value.filter(task => task.recognitionStatus === 'failed').length,
  paused: visibleTasks.value.filter(task => task.recognitionStatus === 'paused').length,
  filled: visibleTasks.value.filter(task => task.usageStatus === 'filled').length
}))
const canFill = computed(() => {
  const task = selectedTask.value
  if (!task || task.businessId !== businessId.value || !pageReady.value || filling.value || busy.value[task.taskId] || loadingDetail.value ||
    task.recognitionStatus !== 'ready' || !task.readyForAutofill || !extraction.value?.readyForAutofill) return false
  if (boundTask.value && boundTask.value.taskId !== task.taskId) return false
  if (task.boundPageId && task.boundPageId !== pageId.value) return false
  return task.usageStatus === 'available' ||
    (task.boundPageId === pageId.value && ['partial', 'filled', 'uncertain'].includes(task.usageStatus))
})
const fillLabel = computed(() => selectedTask.value?.usageStatus === 'filled' ? '重新代填' :
  ['partial', 'uncertain'].includes(selectedTask.value?.usageStatus ?? '') ? '重试代填' : '确认并代填')
const fillHint = computed(() => {
  const task = selectedTask.value
  if (!task) return ''
  if (!pageReady.value) return `请进入${businessName.value}的新建页面，再使用这张票据。`
  if (boundTask.value && boundTask.value.taskId !== task.taskId) return `当前单据已使用另一张票据。请在 ERP 中新建${businessName.value}后处理这张。`
  if (task.boundPageId && task.boundPageId !== pageId.value) return '这张票据正在另一张单据中使用，请回到对应单据继续。'
  if (task.usageStatus === 'uncertain') return task.boundPageId === pageId.value
    ? '上次代填状态未确认，请核对当前单据后重试代填，无需重新识别。'
    : '上次代填未确认完成，请先核对 ERP 中是否已有这张单据。'
  if (!task.boundPageId && ['filled', 'partial'].includes(task.usageStatus)) return '这是已使用的票据。核对 ERP 后，可重新放入待处理列表。'
  if (task.recognitionStatus === 'ready' && !task.readyForAutofill) return '识别结果不完整，暂不可代填。请查看原图及缺失信息，重试识别或更换清晰图片。'
  if (task.usageStatus === 'filled') return `已代填，请在 ERP 中核对并手动保存。处理下一张前，请先新建${businessName.value}。`
  if (task.usageStatus === 'partial') return '部分字段尚未填入，请核对 ERP 提示后重试代填，无需再次识别。'
  return '核对结果后确认代填；其余图片会继续在后台识别。'
})
const headerFields = computed(() => {
  const data = extraction.value
  if (!data) return []
  let fields: [string, unknown][]
  if (data.documentType === 'goods-receipt') {
    const h = data.header
    fields = [
      ['供应商', h.supplierName], ['启运日期', h.departureDate], ['承运单位', h.carrierName],
      ['承运方式', h.transportMethod], ['收货日期', h.receiptDateTime], ['外表温度', h.surfaceTemperature],
      ['运输工具', h.transportVehicle], ['启运地点', h.departurePlace], ['启运时间', h.departureDateTime],
      ['到货时间', h.receiptDateTimeDetail], ['实际运输时长', h.actualTransportHours], ['收货备注', h.receiptRemark]
    ]
  } else {
    const h = data.header
    fields = [
      ['供应商', h.supplierName], ['来源单号', h.sourceOrderNumber], ['票据日期', h.invoiceDate],
      ['启运日期', h.departureDate], ['客户名称', h.customerName], ['收货地址', h.receivingAddress],
      ['承运单位', h.carrierName], ['承运方式', h.transportMethod], ['冷链方式', h.coldChain],
      ['运输时限', h.transportTimeLimit], ['收货备注', h.receiptRemark], ['付款方式', h.paymentMethod],
      ['组别', h.groupName], ['备注', h.remark]
    ]
  }
  return fields.map(([label, value]) => ({ label, value: value === null || value === '' ? '未识别' : String(value) }))
})

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : '操作未完成，请稍后重试'
}

function statusLabel(task: PurchaseQueueTask): string {
  if (task.usageStatus === 'filling') return '正在代填'
  if (task.usageStatus === 'partial') return '部分代填，待重试'
  if (task.usageStatus === 'filled') return '已代填，待 ERP 核对'
  if (task.usageStatus === 'uncertain') return '待确认使用情况'
  if (task.recognitionStatus === 'ready') return task.readyForAutofill ? '识别完成，可代填' : '识别完成，信息待补全'
  if (task.recognitionStatus === 'recognizing') {
    return task.progress?.stage === 'extracting' ? '正在整理字段' : '正在识别'
  }
  return { queued: '排队中', failed: '识别失败', paused: '已暂停，可继续', cancelled: '已取消' }[task.recognitionStatus]
}

function selectTask(taskId: string | null, remember = true): void {
  if (selectedId.value === taskId) return
  closeOriginal()
  selectedId.value = taskId
  detail.value = null
  detailVersion++
  loadingDetail.value = false
  resetCandidate.value = null
  removeCandidate.value = null
  if (taskId && pageId.value && remember) selectedByPage.set(pageId.value, taskId)
  if (taskId) void loadDetail(taskId)
}

function reconcileSelection(pageChanged = false): void {
  if (pageChanged) {
    const remembered = pageId.value ? selectedByPage.get(pageId.value) : undefined
    const existing = visibleTasks.value.find(task => task.taskId === remembered)
    selectTask(boundTask.value?.taskId ?? existing?.taskId ?? null, false)
  }
  if (selectedId.value && !selectedTask.value) selectTask(null, false)
  if (!selectedId.value && isQueuePage.value) {
    const candidate = boundTask.value ?? visibleTasks.value.find(task => task.recognitionStatus === 'ready' && task.readyForAutofill &&
      task.usageStatus === 'available' && !task.boundPageId)
    if (candidate) selectTask(candidate.taskId)
  }
}

async function loadDetail(taskId: string): Promise<void> {
  const version = ++detailVersion
  const epoch = accountEpoch
  loadingDetail.value = true
  let loaded = false
  try {
    const result = await api.get(taskId)
    if (disposed || epoch !== accountEpoch || version !== detailVersion || taskId !== selectedId.value) return
    detail.value = result
    loaded = true
  } catch (cause) {
    if (!disposed && epoch === accountEpoch && version === detailVersion && taskId === selectedId.value) error.value = errorText(cause)
  } finally {
    if (!disposed && version === detailVersion) {
      loadingDetail.value = false
      // A completion may arrive while get() is resolving; fetch that newer revision too.
      if (loaded && selectedTask.value && detail.value?.revision !== selectedTask.value.revision) requestRefresh()
    }
  }
}

function requestRefresh(): void {
  if (disposed || !mounted || !accountId.value || !signedIn.value) return
  refreshRequested = true
  if (!refreshRunning) void refreshLoop()
}

async function refreshLoop(): Promise<void> {
  refreshRunning = true
  try {
    while (refreshRequested && !disposed && accountId.value && signedIn.value) {
      refreshRequested = false
      const epoch = accountEpoch
      try {
        const snapshot = await api.list()
        if (disposed || epoch !== accountEpoch) continue
        tasks.value = [...snapshot].sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence)
        reconcileSelection()
        const task = selectedTask.value
        if (task && !loadingDetail.value && detail.value?.revision !== task.revision) void loadDetail(task.taskId)
      } catch (cause) {
        if (!disposed && epoch === accountEpoch) error.value = errorText(cause)
      }
    }
  } finally {
    refreshRunning = false
  }
}

async function addImages(dropToken?: string): Promise<void> {
  if (!accountId.value || !signedIn.value || importing.value || filling.value || previewOwned) {
    if (dropToken) throw new Error('当前正在导入、代填或查看原图，请处理完成后重新拖入')
    return
  }
  importing.value = true
  const epoch = accountEpoch
  error.value = ''
  notice.value = ''
  importErrors.value = []
  try {
    const targetBusiness = businessId.value
    if (!targetBusiness) return
    const result = dropToken ? await api.addDropped(targetBusiness, dropToken) : await api.add(targetBusiness)
    if (disposed || epoch !== accountEpoch) return
    importErrors.value = result.errors
    if (result.added.length) notice.value = `已加入 ${result.added.length} 张图片，正在后台识别。每张完成后即可使用。`
  } catch (cause) {
    if (!disposed && epoch === accountEpoch) error.value = errorText(cause)
  } finally {
    importing.value = false
    requestRefresh()
  }
}

defineExpose({ importDropped: (token: string) => addImages(token) })

function canRetry(task: PurchaseQueueTask): boolean {
  return !task.boundPageId && task.usageStatus === 'available' &&
    (['failed', 'paused', 'cancelled'].includes(task.recognitionStatus) ||
      (task.recognitionStatus === 'ready' && !task.readyForAutofill))
}

function canCancel(task: PurchaseQueueTask): boolean {
  return !task.boundPageId && task.usageStatus === 'available' &&
    ['queued', 'recognizing', 'paused'].includes(task.recognitionStatus)
}

function canRemove(task: PurchaseQueueTask): boolean {
  return !task.boundPageId && task.usageStatus !== 'filling' &&
    !['queued', 'recognizing'].includes(task.recognitionStatus)
}

function canReset(task: PurchaseQueueTask): boolean {
  return !task.boundPageId && task.recognitionStatus === 'ready' &&
    ['partial', 'filled', 'uncertain'].includes(task.usageStatus)
}

async function taskAction(task: PurchaseQueueTask, action: 'retry' | 'cancel' | 'remove' | 'resetUsage'): Promise<void> {
  if (busy.value[task.taskId] || !signedIn.value || filling.value) return
  busy.value = { ...busy.value, [task.taskId]: action }
  error.value = ''
  try {
    await api[action](task.taskId)
    removeCandidate.value = null
    resetCandidate.value = null
    if (action === 'remove' && selectedId.value === task.taskId) selectTask(null)
  } catch (cause) {
    if (!disposed) error.value = errorText(cause)
  } finally {
    const next = { ...busy.value }
    delete next[task.taskId]
    busy.value = next
    requestRefresh()
  }
}

async function fillSelected(): Promise<void> {
  const task = selectedTask.value
  const targetPage = pageId.value
  if (!task || !targetPage || !canFill.value) return
  busy.value = { ...busy.value, [task.taskId]: 'fill' }
  error.value = ''
  try {
    const result = await api.fill({ taskId: task.taskId, pageId: targetPage })
    if (!disposed && selectedId.value === task.taskId && pageId.value === targetPage && result.status !== 'filled') {
      error.value = result.message
    }
  } catch (cause) {
    if (!disposed && selectedId.value === task.taskId && pageId.value === targetPage) error.value = errorText(cause)
  } finally {
    const next = { ...busy.value }
    delete next[task.taskId]
    busy.value = next
    requestRefresh()
  }
}

function useNext(): void {
  if (!pageReady.value || boundTask.value || filling.value || !nextTask.value) return
  selectTask(nextTask.value.taskId)
}

function enqueuePreview<T>(operation: () => Promise<T>): Promise<T> {
  const next = previewTail.then(operation)
  previewTail = next.then(() => undefined, () => undefined)
  return next
}

function closeOriginal(): void {
  const hadPreview = previewOwned
  previewOwned = false
  previewVersion++
  preview.value = null
  previewBusy.value = false
  zoomPage.value = null
  if (hadPreview) {
    void enqueuePreview(() => api.closePreview()).catch(cause => {
      if (!disposed) error.value = errorText(cause)
    })
    void nextTick(() => previewButton.value?.focus())
  }
}

async function showOriginal(): Promise<void> {
  const task = selectedTask.value
  if (!task || previewBusy.value || filling.value || !signedIn.value) return
  const version = ++previewVersion
  const epoch = accountEpoch
  previewOwned = true
  previewBusy.value = true
  error.value = ''
  try {
    const result = await enqueuePreview(() => disposed || version !== previewVersion
      ? Promise.resolve(null) : api.preview(task.taskId))
    if (!result || disposed || version !== previewVersion || epoch !== accountEpoch || selectedId.value !== task.taskId) return
    preview.value = result
    await nextTick()
    previewDialog.value?.querySelector<HTMLButtonElement>('[data-testid="purchase-preview-close"]')?.focus()
  } catch (cause) {
    if (!disposed && version === previewVersion) {
      error.value = errorText(cause)
      closeOriginal()
    }
  } finally {
    if (version === previewVersion) previewBusy.value = false
  }
}

function handlePreviewKey(event: KeyboardEvent): void {
  if (!preview.value && !previewBusy.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (zoomPage.value) zoomPage.value = null
    else closeOriginal()
  }
  if (event.key === 'Tab' && previewDialog.value) {
    const buttons = [...previewDialog.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}

function beforeUnload(): void {
  if (previewOwned) void api.closePreview().catch(() => undefined)
  closeOriginal()
}

watch(accountId, () => {
  accountEpoch++
  tasks.value = []
  selectedByPage.clear()
  selectTask(null)
  error.value = ''
  notice.value = ''
  importErrors.value = []
  requestRefresh()
})
watch(() => `${props.erpState.currentPage?.businessId ?? ''}:${props.erpState.currentPage?.pageId ?? ''}`, () => {
  closeOriginal()
  resetCandidate.value = null
  removeCandidate.value = null
  error.value = ''
  reconcileSelection(true)
  requestRefresh()
})
watch(signedIn, ready => {
  if (!ready) {
    accountEpoch++
    closeOriginal()
    tasks.value = []
    selectedByPage.clear()
    selectTask(null)
    notice.value = ''
    error.value = ''
    importErrors.value = []
  } else requestRefresh()
})

onMounted(() => {
  mounted = true
  // Subscribe first so completions during the initial snapshot are not missed.
  unsubscribe = api.onChanged(requestRefresh)
  window.addEventListener('keydown', handlePreviewKey)
  window.addEventListener('beforeunload', beforeUnload)
  requestRefresh()
})
onBeforeUnmount(() => {
  disposed = true
  detailVersion++
  unsubscribe?.()
  window.removeEventListener('keydown', handlePreviewKey)
  window.removeEventListener('beforeunload', beforeUnload)
  closeOriginal()
})
</script>

<template>
  <section v-if="isQueuePage || tasks.length" class="purchase-queue" data-testid="purchase-queue">
    <header class="purchase-queue-heading">
      <div><h3>{{ businessName }}票据队列</h3><p>每个文件独立识别，完成一张即可使用。</p></div>
      <span v-if="counts.running" class="purchase-running-badge">{{ counts.running }} 张识别中</span>
    </header>
    <p v-if="!accountId" class="purchase-hint">请从账号管理打开已保存的账号后，使用批量识别。手动登录窗口无法确认票据归属。</p>
    <template v-else>
      <p v-if="!signedIn" class="purchase-hint">账号尚未登录就绪，票据已保留。登录完成后可继续处理。</p>
      <button v-if="isQueuePage" type="button" class="primary-button purchase-add" data-testid="purchase-add"
        :disabled="!signedIn || importing || filling" @click="addImages()">
        {{ importing ? '正在加入图片…' : visibleTasks.length ? '继续添加图片' : '批量选择图片并识别' }}
      </button>
      <p v-if="isQueuePage" class="purchase-hint">也可将多张图片或 PDF 拖入软件界面，直接开始识别，无需再次筛选。结果保存在本机，可在后续新建{{ businessName }}时使用。</p>
      <p v-if="notice && isQueuePage" class="purchase-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="purchase-error" role="alert">{{ error }}</p>
      <ul v-if="importErrors.length && isQueuePage" class="purchase-import-errors" aria-label="未加入的图片">
        <li v-for="(failure, index) in importErrors" :key="index"><strong>{{ failure.fileName }}</strong>：{{ failure.message }}</li>
      </ul>
      <div v-if="visibleTasks.length" class="purchase-counts" aria-live="polite" aria-atomic="true">
        <span>共 {{ counts.total }} 张</span><span>排队 {{ counts.waiting }}</span><span>可代填 {{ counts.ready }}</span>
        <span v-if="counts.review">待补全 {{ counts.review }}</span><span v-if="counts.paused">已暂停 {{ counts.paused }}</span>
        <span v-if="counts.failed">失败 {{ counts.failed }}</span><span v-if="counts.filled">已代填 {{ counts.filled }}</span>
      </div>
      <ol v-if="visibleTasks.length" class="purchase-task-list" :aria-label="`${businessName}票据处理队列`">
        <li v-for="(task, index) in visibleTasks" :key="task.taskId" :data-selected="selectedId === task.taskId">
          <button type="button" class="purchase-task-select" data-testid="purchase-task" :data-task-id="task.taskId"
            :data-recognition-status="task.recognitionStatus" :data-usage-status="task.usageStatus"
            :aria-pressed="selectedId === task.taskId" @click="selectTask(task.taskId)">
            <span class="purchase-task-number">{{ index + 1 }}</span>
            <span class="purchase-task-content"><strong :title="task.fileName">{{ task.fileName }}</strong><small v-if="!isQueuePage">{{ BUSINESS_DEFINITIONS[task.businessId].name }}</small>
              <small>{{ task.supplierName || '供应商待识别' }}<template v-if="task.sourceOrderNumber"> · {{ task.sourceOrderNumber }}</template></small>
              <span class="purchase-task-state" :data-status="task.usageStatus === 'available' ? task.recognitionStatus : task.usageStatus">{{ statusLabel(task) }}</span>
              <small v-if="task.boundPageId">{{ task.boundPageId === pageId ? '当前单据正在使用' : '其他单据正在使用' }}</small>
            </span>
          </button>
          <div v-if="canRetry(task) || canCancel(task) || canRemove(task)" class="purchase-task-actions">
            <button v-if="canRetry(task)" type="button" :disabled="!signedIn || Boolean(busy[task.taskId]) || filling" @click="taskAction(task, 'retry')">{{ task.recognitionStatus === 'paused' ? '继续识别' : '重试识别' }}</button>
            <button v-if="canCancel(task)" type="button" :disabled="!signedIn || Boolean(busy[task.taskId]) || filling" @click="taskAction(task, 'cancel')">取消识别</button>
            <button v-if="canRemove(task)" type="button" :disabled="!signedIn || Boolean(busy[task.taskId]) || filling" @click="removeCandidate = removeCandidate === task.taskId ? null : task.taskId">删除</button>
          </div>
          <div v-if="removeCandidate === task.taskId" class="purchase-inline-confirm">
            <p>删除这张票据的本地图片及识别结果？</p>
            <button type="button" :disabled="Boolean(busy[task.taskId]) || filling" @click="taskAction(task, 'remove')">确认删除</button>
            <button type="button" @click="removeCandidate = null">保留</button>
          </div>
        </li>
      </ol>
      <p v-else-if="isQueuePage" class="purchase-empty">一次选择多张票据图片，识别期间可以继续在 ERP 中工作。</p>

      <section v-if="selectedTask && isQueuePage" class="purchase-detail" data-testid="purchase-detail" :data-task-id="selectedTask.taskId">
        <div class="purchase-detail-heading"><h3 :title="selectedTask.fileName">{{ selectedTask.fileName }}</h3>
          <button ref="previewButton" type="button" class="secondary-button" data-testid="purchase-preview"
            :disabled="!signedIn || previewBusy || filling || Boolean(busy[selectedTask.taskId])" @click="showOriginal">{{ previewBusy ? '正在打开…' : '查看原图' }}</button>
        </div>
        <p class="purchase-task-state" :data-status="selectedTask.recognitionStatus">{{ statusLabel(selectedTask) }}</p>
        <p v-if="selectedTask.progress && ['queued', 'recognizing'].includes(selectedTask.recognitionStatus)" class="purchase-hint" role="status">{{ selectedTask.progress.message }}</p>
        <p v-if="selectedTask.message && selectedTask.recognitionStatus !== 'recognizing'" class="purchase-hint">{{ selectedTask.message }}</p>
        <p v-if="loadingDetail && !extraction" class="purchase-hint" role="status">正在读取本地识别结果…</p>
        <template v-if="extraction && detail?.result">
          <p v-if="extraction.documentType === 'goods-receipt'" class="purchase-hint">货账相符、随货单合规等验收结论仍需在 ERP 中人工确认。</p>
          <div class="purchase-metrics"><span>商品 <strong>{{ extraction.items.length }}</strong> 项</span><span>字段覆盖 <strong>{{ detail.result.coveragePercent }}%</strong></span></div>
          <dl class="purchase-fields"><div v-for="field in headerFields" :key="field.label"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></div></dl>
          <details v-if="extraction.reviewRequired.length || extraction.missingRecommendedFields.length || detail.result.warnings.length" class="issues-card" :open="!extraction.readyForAutofill">
            <summary>识别提醒与待核对信息</summary>
            <p v-for="(message, index) in extraction.reviewRequired" :key="`review-${index}`">{{ message }}</p>
            <p v-if="extraction.missingRecommendedFields.length">仍有 {{ extraction.missingRecommendedFields.length }} 项建议字段未识别，请对照原图核对。</p>
            <p v-for="(message, index) in detail.result.warnings" :key="`warning-${index}`">{{ message }}</p>
          </details>
          <details class="purchase-items" open><summary>商品明细（{{ extraction.items.length }}）</summary>
            <article v-for="(item, index) in extraction.items" :key="index">
              <h4>{{ index + 1 }}. {{ item.productName }}</h4><p>{{ item.specification || '规格未识别' }} · {{ item.manufacturer || '生产企业未识别' }}</p>
              <p v-if="'quantity' in item">数量 {{ item.quantity ?? '—' }} {{ item.unit || '' }} · 含税单价 {{ item.taxIncludedUnitPrice ?? '—' }} · 金额 {{ item.taxIncludedAmount ?? '—' }}</p>
              <p v-else>到货数量 {{ item.arrivalQuantity ?? '—' }} · 实收数量 {{ item.receiptQuantity ?? '—' }} {{ item.unit || '' }} · 单价 {{ item.unitPrice ?? '—' }} · 金额 {{ item.amount ?? '—' }}</p>
              <p>批号 {{ item.batchNumber || '—' }} · 生产日期 {{ item.productionDate || '—' }} · 有效期 {{ item.expiryDate || '—' }}</p>
              <p>批准文号 {{ item.approvalNumber || '—' }}</p>
              <p v-if="'origin' in item && (item.dosageForm || item.origin || item.qualityStatus)">{{ item.dosageForm || '' }}<template v-if="item.origin"> · 产地 {{ item.origin }}</template><template v-if="item.qualityStatus"> · {{ item.qualityStatus }}</template></p>
              <p v-if="item.marketingAuthorizationHolder">上市许可持有人 {{ item.marketingAuthorizationHolder }}</p>
            </article>
          </details>
          <details class="ocr-details"><summary>查看识别原文</summary><details v-for="page in detail.result.pages" :key="page.pageNumber">
            <summary>第 {{ page.pageNumber }} 页</summary><pre>{{ page.text || '该页没有可用文字' }}</pre>
          </details></details>
        </template>
        <div v-if="selectedTask.lastFill" class="purchase-fill-result" :data-error="selectedTask.lastFill.status !== 'filled'">
          <strong>{{ selectedTask.lastFill.status === 'filled' ? '已代填，待 ERP 核对保存' : '代填未全部完成' }}</strong>
          <p>{{ selectedTask.lastFill.message }}</p>
          <p v-if="selectedTask.lastFill.skippedFields.length">未填：{{ selectedTask.lastFill.skippedFields.join('、') }}</p>
        </div>
        <p class="purchase-hint">{{ fillHint }}</p>
        <div v-if="canReset(selectedTask)" class="purchase-reset">
          <button type="button" class="secondary-button" :disabled="!signedIn || filling || Boolean(busy[selectedTask.taskId])" @click="resetCandidate = selectedTask.taskId">重新放入待处理</button>
          <div v-if="resetCandidate === selectedTask.taskId" class="purchase-inline-confirm">
            <p>请先核对 ERP，确认这张票据是否已经保存，避免重复建单。重新放回后不会再次调用识别。</p>
            <button type="button" :disabled="!signedIn || filling || Boolean(busy[selectedTask.taskId])" @click="taskAction(selectedTask, 'resetUsage')">已核对，重新放入</button>
            <button type="button" @click="resetCandidate = null">暂不处理</button>
          </div>
        </div>
        <div class="purchase-fill-actions">
          <button type="button" class="primary-button" data-testid="purchase-fill" :disabled="!canFill" @click="fillSelected">{{ busy[selectedTask.taskId] === 'fill' || selectedTask.usageStatus === 'filling' ? '正在代填…' : fillLabel }}</button>
          <button v-if="nextTask" type="button" class="secondary-button" data-testid="purchase-next" :disabled="!pageReady || Boolean(boundTask) || filling" @click="useNext">使用下一张已识别票据</button>
        </div>
      </section>
      <p v-else-if="isQueuePage && visibleTasks.length" class="purchase-hint">可以代填的结果会自动展示；也可点击队列中的票据查看进度，复核待补全的信息。</p>
      <p v-else-if="tasks.length" class="purchase-hint">后台识别继续进行。进入对应的采购订单或商品收货登记新建页后，即可使用已完成结果。</p>
    </template>

    <Teleport to="body">
      <div v-if="preview" class="preview-backdrop purchase-preview-backdrop" role="presentation" @click.self="closeOriginal">
        <section ref="previewDialog" class="preview-dialog purchase-preview-dialog" data-testid="purchase-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-preview-title">
          <header class="purchase-preview-heading"><div><h2 id="purchase-preview-title">票据原图</h2><p>{{ preview.fileName }} · 共 {{ preview.pageCount }} 页</p></div>
            <button type="button" class="secondary-button" data-testid="purchase-preview-close" @click="closeOriginal">关闭原图</button>
          </header>
          <p class="purchase-preview-note">用于核对识别结果，点击图片可放大查看。</p>
          <div class="purchase-preview-pages"><button v-for="page in preview.pages" :key="page.pageNumber" type="button" class="purchase-preview-page" @click="zoomPage = page">
            <img :src="page.thumbnailDataUrl" :alt="`第 ${page.pageNumber} 页票据原图`" /><span>第 {{ page.pageNumber }} 页 · 点击放大</span>
          </button></div>
          <div v-if="zoomPage" class="purchase-zoom" role="presentation" @click.self="zoomPage = null">
            <section role="dialog" aria-modal="true" aria-label="票据放大预览"><header><strong>第 {{ zoomPage.pageNumber }} 页</strong><button type="button" class="secondary-button" @click="zoomPage = null">关闭大图</button></header>
              <div><img :src="zoomPage.thumbnailDataUrl" :alt="`第 ${zoomPage.pageNumber} 页放大原图`" /></div>
            </section>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>
