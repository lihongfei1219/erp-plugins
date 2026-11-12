<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AccountManager from './AccountManager.vue'
import PurchaseQueue from './PurchaseQueue.vue'
import {
  BUSINESS_DEFINITIONS,
  type BusinessId,
  type GoodsReceiptExtraction,
  type PurchaseOrderExtraction,
  type UnitInitialApprovalExtraction,
  type WorkflowSession
} from '../../shared/business'
import type { ErpAutofillResult, ErpState } from '../../shared/erp'
import type { OcrClientResult, OcrDocumentBatch, OcrProgress } from '../../shared/ocr'
import type { FileDropFeedback } from '../../shared/file-drop'

interface ClientWorkflowSession extends WorkflowSession {
  pageId: string
  batch: OcrDocumentBatch | null
  progress: OcrProgress | null
  result: OcrClientResult | null
}

interface ReviewField {
  label: string
  target: string
  value: string
  status: 'ready' | 'review' | 'match' | 'missing'
}

const platform = window.desktop.platform
const isAccountManager = window.location.hash === '#accounts'
const accountActionError = ref('')
async function accountAction(action: 'manager' | 'retryLogin'): Promise<void> {
  accountActionError.value = ''
  try { await window.desktop.accounts[action]() }
  catch { accountActionError.value = '操作未完成，请稍后重试' }
}
const erpState = ref<ErpState>({
  configured: false,
  status: 'not-configured',
  url: null,
  canGoBack: false,
  canGoForward: false,
  message: null,
  currentPage: null,
  openPageIds: []
})
const assistantCollapsed = ref(false)
const queuePanel = ref<InstanceType<typeof PurchaseQueue> | null>(null)
const dropError = ref('')
let unsubscribeDrops: (() => void) | undefined
let handlingDrop = false

async function handleDrop(value: FileDropFeedback): Promise<void> {
  assistantCollapsed.value = false
  void window.desktop.erp.setAssistantWidth(400)
  if (value.kind === 'error') { dropError.value = value.message; return }
  if (handlingDrop) { dropError.value = '正在导入上一批文件，请完成后重新拖入'; return }
  handlingDrop = true
  dropError.value = ''
  try {
    await nextTick()
    const page = erpState.value.currentPage
    if (page?.businessId !== value.businessId || page.pageId !== value.pageId) throw new Error('业务页面已切换，请在目标页面重新拖入')
    if (recognitionRunning.value || autofillStatus.value === 'running') {
      throw new Error('请先完成当前识别或代填，再拖入新文件')
    }
    if (value.businessId === 'unit-initial-approval') await selectDocument(value.token)
    else {
      if (!queuePanel.value) throw new Error('票据队列尚未就绪，请稍后重新拖入')
      await queuePanel.value.importDropped(value.token)
    }
  } catch (error) {
    dropError.value = error instanceof Error ? error.message : '导入失败，请重新拖入'
  } finally { handlingDrop = false }
}
onBeforeUnmount(() => unsubscribeDrops?.())
const sessions = ref<Record<string, ClientWorkflowSession>>({})
const activeSessionId = ref<string | null>(null)
const autofillStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
const autofillResult = ref<ErpAutofillResult | null>(null)

const statusLabel = computed(() => {
  const labels: Record<ErpState['status'], string> = {
    'not-configured': '待配置',
    loading: '正在加载',
    ready: '已连接',
    error: '加载失败'
  }
  return labels[erpState.value.status]
})
const currentBusinessId = computed(() => erpState.value.currentPage?.businessId ?? null)
const isQueueBusinessPage = computed(() => currentBusinessId.value === 'purchase-order' || currentBusinessId.value === 'goods-receipt')
const currentBusiness = computed(() => {
  const businessId = currentBusinessId.value
  return businessId ? BUSINESS_DEFINITIONS[businessId] : null
})
const currentPageReady = computed(
  () => Boolean((!erpState.value.account || erpState.value.account.status === 'signed-in') && erpState.value.currentPage?.pageId && erpState.value.currentPage?.supported && erpState.value.currentPage?.isNew)
)
const activeSession = computed(() => {
  const sessionId = activeSessionId.value
  if (!sessionId) return null
  const session = sessions.value[sessionId] ?? null
  return session?.businessId === currentBusinessId.value && session.pageId === erpState.value.currentPage?.pageId ? session : null
})
const batchItems = computed(() => activeSession.value?.batch?.items ?? [])
const failedBatchItems = computed(() => batchItems.value.filter((item) => item.status === 'failed'))
const recognitionRunning = computed(
  () => activeSession.value?.status === 'recognizing'
)
const ocrResult = computed(() => activeSession.value?.result ?? null)
const extractedData = computed(() => ocrResult.value?.result?.extractedData ?? null)
const ocrProgress = computed(() => activeSession.value?.progress ?? null)
const ocrProgressPercent = computed(() => {
  const progress = ocrProgress.value
  if (!progress) return 0
  if (progress.stage === 'completed') return 100
  if (progress.total <= 0) return 8
  return Math.max(8, Math.min(96, Math.round((progress.current / progress.total) * 100)))
})
const workflowStep = computed(() => {
  const status = activeSession.value?.status
  if (!status || status === 'ready') return 1
  if (status === 'recognizing') return 2
  if (status === 'reviewing' || status === 'failed') return 3
  return 4
})
const canConfirmAutofill = computed(
  () => Boolean(
    (activeSession.value?.status === 'reviewing' || activeSession.value?.status === 'completed') &&
      autofillStatus.value !== 'running' &&
      extractedData.value?.readyForAutofill &&
      currentPageReady.value &&
      extractedData.value.documentType === currentBusinessId.value
  )
)
const workflowSteps = [
  { number: 1, label: '选择资料' },
  { number: 2, label: 'OCR识别' },
  { number: 3, label: '核对匹配' },
  { number: 4, label: '确认代填' }
]

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未识别'
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '未识别'
  return String(value)
}

const reviewFields = computed<ReviewField[]>(() => {
  const extraction = extractedData.value
  if (!extraction) return []
  if (extraction.documentType === 'purchase-order') {
    const header = extraction.header
    return [
      { label: '供应商', target: '单位名称 · DWMC', value: displayValue(header.supplierName), status: header.supplierName ? 'match' : 'missing' },
      { label: '来源单号', target: '备注依据', value: displayValue(header.sourceOrderNumber), status: header.sourceOrderNumber ? 'review' : 'missing' },
      { label: '启运日期', target: 'QYRQ', value: displayValue(header.departureDate), status: header.departureDate ? 'ready' : 'missing' },
      { label: '承运单位', target: 'CYDW', value: displayValue(header.carrierName), status: header.carrierName ? 'match' : 'missing' },
      { label: '承运方式', target: 'CYFS', value: displayValue(header.transportMethod), status: header.transportMethod ? 'match' : 'missing' },
      { label: '付款方式', target: 'FKFS', value: displayValue(header.paymentMethod), status: header.paymentMethod ? 'ready' : 'review' },
      { label: '备注', target: 'BZ', value: displayValue(header.remark), status: header.remark ? 'ready' : 'missing' }
    ]
  }
  if (extraction.documentType === 'goods-receipt') {
    const header = extraction.header
    return [
      { label: '供应商', target: '单位名称 · DWMC', value: displayValue(header.supplierName), status: header.supplierName ? 'ready' : 'missing' },
      { label: '启运日期', target: 'QYRQ', value: displayValue(header.departureDate), status: header.departureDate ? 'ready' : 'missing' },
      { label: '承运单位', target: 'CYDW', value: displayValue(header.carrierName), status: header.carrierName ? 'ready' : 'missing' },
      { label: '承运方式', target: 'CYFS', value: displayValue(header.transportMethod), status: header.transportMethod ? 'ready' : 'missing' },
      { label: '启运地点', target: 'qydd', value: displayValue(header.departurePlace), status: header.departurePlace ? 'ready' : 'missing' },
      { label: '外表温度', target: 'WBWD', value: displayValue(header.surfaceTemperature), status: header.surfaceTemperature !== null ? 'review' : 'missing' },
      { label: '收货备注', target: 'SHDJBZ', value: displayValue(header.receiptRemark), status: header.receiptRemark ? 'ready' : 'missing' }
    ]
  }
  const header = extraction.header
  return [
    { label: '单位名称', target: 'DWMC', value: displayValue(header.unitName), status: header.unitName ? 'ready' : 'missing' },
    { label: '营业执照号', target: 'YYZZH', value: displayValue(header.businessLicenseNo), status: header.businessLicenseNo ? 'review' : 'missing' },
    { label: '注册地址', target: 'ZCDZ', value: displayValue(header.registeredAddress), status: header.registeredAddress ? 'ready' : 'missing' },
    { label: '仓库地址', target: 'CKDZ', value: displayValue(header.warehouseAddress), status: header.warehouseAddress ? 'ready' : 'missing' },
    { label: '开户银行', target: 'GSKHYH', value: displayValue(header.companyBankName), status: header.companyBankName ? 'review' : 'missing' },
    { label: '银行账号', target: 'GSKHZH', value: displayValue(header.companyBankAccount), status: header.companyBankAccount ? 'review' : 'missing' },
    { label: '经营范围', target: 'JYFW', value: displayValue(header.businessScope), status: header.businessScope.length > 0 ? 'ready' : 'missing' }
  ]
})

function patchSession(sessionId: string, patch: Partial<ClientWorkflowSession>): void {
  const session = sessions.value[sessionId]
  if (!session) return
  sessions.value = { ...sessions.value, [sessionId]: { ...session, ...patch } }
}

function createSession(businessId: BusinessId): ClientWorkflowSession {
  const session: ClientWorkflowSession = {
    sessionId: crypto.randomUUID(),
    businessId,
    pageId: erpState.value.currentPage!.pageId!,
    status: 'ready',
    createdAt: Date.now(),
    batch: null,
    progress: null,
    result: null
  }
  sessions.value = { ...sessions.value, [session.sessionId]: session }
  activeSessionId.value = session.sessionId
  return session
}

function goBack(): void { void window.desktop.erp.goBack() }
function goForward(): void { void window.desktop.erp.goForward() }
function reload(): void { void window.desktop.erp.reload() }

function toggleAssistant(): void {
  assistantCollapsed.value = !assistantCollapsed.value
  void window.desktop.erp.setAssistantWidth(assistantCollapsed.value ? 56 : 400)
}

async function fillFixture(): Promise<void> {
  const businessId = currentBusinessId.value
  if (!businessId || (businessId === 'purchase-order' || businessId === 'goods-receipt') || !currentPageReady.value) return
  autofillStatus.value = 'running'
  autofillResult.value = null
  try {
    const result = await window.desktop.erp.fillFixture({ businessId })
    autofillResult.value = result
    autofillStatus.value = result.status === 'filled' ? 'success' : 'error'
  } catch (error) {
    autofillResult.value = {
      status: 'failed', message: error instanceof Error ? error.message : '测试数据代填失败',
      filledHeaderFields: 0, filledDetailRows: 0, skippedFields: []
    }
    autofillStatus.value = 'error'
  }
}

async function selectDocument(dropToken?: string): Promise<void> {
  const businessId = currentBusinessId.value
  if (businessId !== 'unit-initial-approval' || !currentPageReady.value) return
  const session = createSession(businessId)
  autofillResult.value = null
  patchSession(session.sessionId, {
    status: 'recognizing',
    progress: {
      sessionId: session.sessionId,
      businessId,
      stage: 'queued',
      current: 0,
      total: 0,
      message: '请选择单位首营资料，可一次选择多张图片'
    }
  })
  try {
    const selection = await window.desktop.ocr.selectDocument({
      sessionId: session.sessionId,
      businessId,
      pageId: session.pageId,
      dropToken
    })
    if (selection.status === 'cancelled') {
      patchSession(session.sessionId, { status: 'ready', progress: null })
      return
    }
    if (selection.status === 'failed' || !selection.batch) {
      patchSession(session.sessionId, {
        status: 'failed',
        progress: null,
        result: { status: 'failed', message: selection.message, result: null }
      })
      return
    }
    if (selection.batch.businessId !== businessId || selection.batch.sessionId !== session.sessionId) {
      throw new Error('导入结果与当前单位首营会话不一致')
    }
    patchSession(session.sessionId, { batch: selection.batch })
    await runExtraction(session.sessionId, selection.batch, false)
  } catch (error) {
    patchSession(session.sessionId, {
      status: 'failed',
      progress: null,
      result: { status: 'failed', message: error instanceof Error ? error.message : '单位资料识别请求失败', result: null }
    })
  }
}

async function runExtraction(
  sessionId: string,
  batch: OcrDocumentBatch,
  retryFailed: boolean
): Promise<void> {
  patchSession(sessionId, {
    status: 'recognizing',
    progress: {
      sessionId,
      businessId: batch.businessId,
      stage: 'queued',
      current: 0,
      total: retryFailed ? batch.items.filter((item) => item.status === 'failed').length : batch.items.length,
      message: retryFailed ? '正在重试识别失败的文件' : `正在识别 ${batch.items.length} 个单位资料文件`
    }
  })
  try {
    const result = await window.desktop.ocr.extractDocument({
      sessionId,
      businessId: batch.businessId,
      token: batch.token,
      retryFailed
    })
    if (result.result && result.result.businessId !== batch.businessId) {
      throw new Error('识别结果与当前单位首营会话不一致')
    }
    const nextBatch = result.result?.batchItems
      ? { ...batch, items: result.result.batchItems }
      : batch
    patchSession(sessionId, {
      status: result.status === 'completed' ? 'reviewing' : 'failed',
      batch: nextBatch,
      progress: null,
      result
    })
  } catch (error) {
    patchSession(sessionId, {
      status: 'failed',
      progress: null,
      result: { status: 'failed', message: error instanceof Error ? error.message : '单位资料识别请求失败', result: null }
    })
  }
}

async function retryFailedDocuments(): Promise<void> {
  const session = activeSession.value
  if (!session?.batch || failedBatchItems.value.length === 0 || recognitionRunning.value) return
  await runExtraction(session.sessionId, session.batch, true)
}

async function confirmAutofill(): Promise<void> {
  const session = activeSession.value
  if (!session || (session.businessId === 'purchase-order' || session.businessId === 'goods-receipt') || !canConfirmAutofill.value) return
  patchSession(session.sessionId, { status: 'filling' })
  autofillStatus.value = 'running'
  autofillResult.value = null
  try {
    const result = await window.desktop.erp.fillSession({ sessionId: session.sessionId, businessId: session.businessId })
    patchSession(session.sessionId, { status: result.status === 'filled' ? 'completed' : 'reviewing' })
    if (activeSessionId.value !== session.sessionId) return
    autofillResult.value = result
    autofillStatus.value = result.status === 'filled' ? 'success' : 'error'
  } catch (error) {
    patchSession(session.sessionId, { status: 'reviewing' })
    if (activeSessionId.value !== session.sessionId) return
    autofillResult.value = {
      status: 'failed', message: error instanceof Error ? error.message : '代填失败',
      filledHeaderFields: 0, filledDetailRows: 0, skippedFields: []
    }
    autofillStatus.value = 'error'
  }
}

onMounted(async () => {
  if (isAccountManager) return
  unsubscribeDrops = window.desktop.files.onDrop(value => { void handleDrop(value) })
  erpState.value = await window.desktop.erp.getState()
  await window.desktop.erp.setAssistantWidth(400)
  window.desktop.erp.onStateChanged((state) => {
    const previousSessionId = activeSessionId.value
    erpState.value = state
    const openPages = new Set(state.openPageIds)
    sessions.value = Object.fromEntries(Object.entries(sessions.value).filter(([, session]) => openPages.has(session.pageId)))
    const current = previousSessionId ? sessions.value[previousSessionId] : null
    activeSessionId.value = current && current.pageId === state.currentPage?.pageId ? current.sessionId :
      Object.values(sessions.value).filter(session => session.pageId === state.currentPage?.pageId)
        .sort((a, b) => b.createdAt - a.createdAt)[0]?.sessionId ?? null
    if (previousSessionId !== activeSessionId.value) {
      autofillResult.value = null
      autofillStatus.value = 'idle'
    }
  })
  window.desktop.ocr.onProgress((progress) => {
    const session = sessions.value[progress.sessionId]
    if (session?.businessId !== progress.businessId) return
    const batch = session.batch && progress.itemId && progress.itemStatus
      ? {
          ...session.batch,
          items: session.batch.items.map((item) => item.id === progress.itemId
            ? { ...item, status: progress.itemStatus!, message: progress.message }
            : item)
        }
      : session.batch
    patchSession(progress.sessionId, { progress, batch })
  })
})
</script>

<template>
  <AccountManager v-if="isAccountManager" />
  <main v-else class="app-shell" :data-assistant-collapsed="assistantCollapsed">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-mark">E</span>
        <div><strong>{{ erpState.account?.label ?? 'ERP 票据助手' }}</strong><small>{{ erpState.account?.username ?? `${platform} · 手动登录` }}</small></div>
      </div>
      <nav class="navigation" aria-label="ERP 页面导航">
        <button type="button" aria-label="后退" :disabled="!erpState.canGoBack" @click="goBack">←</button>
        <button type="button" aria-label="前进" :disabled="!erpState.canGoForward" @click="goForward">→</button>
        <button type="button" aria-label="刷新" :disabled="!erpState.configured" @click="reload">↻</button>
      </nav>
      <div class="address" :title="erpState.url ?? ''">{{ erpState.url ?? '尚未配置 ERP 地址' }}</div>
      <span v-if="currentBusiness" class="business-badge">{{ currentBusiness.name }}</span>
      <span class="connection" :data-status="erpState.status" :title="erpState.account?.message">{{ erpState.account?.message ?? statusLabel }}</span>
      <button v-if="erpState.account && ['paused', 'failed', 'mismatch'].includes(erpState.account.status)" class="account-toolbar-button" @click="accountAction('retryLogin')">重新登录</button>
      <button class="account-toolbar-button" @click="accountAction('manager')">账号管理</button>
    </header>

    <section class="erp-stage">
      <div v-if="!erpState.configured" class="empty-state">
        <p class="eyebrow">ERP URL REQUIRED</p><h1>配置 ERP 地址</h1>
        <p>复制 <code>.env.example</code> 为 <code>.env</code>，填写 ERP 登录页地址后重新启动。</p>
      </div>
    </section>

    <aside class="assistant-panel">
      <button type="button" class="assistant-toggle" :aria-label="assistantCollapsed ? '展开业务助手' : '收起业务助手'" @click="toggleAssistant">
        {{ assistantCollapsed ? '‹' : '›' }}
      </button>
      <div v-if="!assistantCollapsed" class="assistant-content">
        <p v-if="dropError" class="account-error" data-testid="file-drop-error" role="alert">{{ dropError }}</p>
        <p v-if="accountActionError" class="account-error" role="alert">{{ accountActionError }}</p>
        <header class="context-card" :data-supported="currentPageReady">
          <div>
            <p class="eyebrow">CURRENT ERP PAGE</p>
            <h2>{{ currentBusiness?.name ?? '等待识别业务页面' }}</h2>
            <p v-if="currentBusiness">{{ currentBusiness.moduleName }} · {{ erpState.currentPage?.isNew ? '新建' : '非新建状态' }}</p>
            <p v-else>请在 ERP 中进入已经支持的业务新建页面。</p>
          </div>
          <span>{{ currentPageReady ? '已就绪' : '不可代填' }}</span>
        </header>

        <PurchaseQueue ref="queuePanel" :erp-state="erpState" />

        <ol v-if="!isQueueBusinessPage" class="workflow-steps" aria-label="票据处理步骤">
          <li v-for="step in workflowSteps" :key="step.number" :data-active="workflowStep === step.number" :data-completed="workflowStep > step.number">
            <span>{{ workflowStep > step.number ? '✓' : step.number }}</span><small>{{ step.label }}</small>
          </li>
        </ol>

        <section v-if="!currentPageReady && !isQueueBusinessPage" class="panel-state">
          <div class="state-icon">⌁</div><strong>当前页面没有可用的代填任务</strong>
          <p>进入以下任一业务的新建页后，助手会自动切换，不会沿用其他业务的数据。</p>
          <div class="supported-businesses">
            <article v-for="business in BUSINESS_DEFINITIONS" :key="business.id">
              <strong>{{ business.name }}</strong><small>{{ business.description }}</small>
            </article>
          </div>
        </section>

        <template v-else-if="currentPageReady && !isQueueBusinessPage">
          <section v-if="!activeSession || activeSession.status === 'ready'" class="intake-card">
            <p class="eyebrow">DOCUMENT INTAKE</p><h3>选择{{ currentBusiness?.documentName }}</h3>
            <p>识别结果暂存在当前单据页，关闭该单据页后自动清除。</p>
            <button type="button" class="primary-button" :disabled="recognitionRunning" @click="selectDocument()">选择单位资料并识别</button>
            <p class="purchase-hint">可多选或同时拖入多张图片；本批文件共同组成一个单位的首营资料。拖入仅在本页面生效。</p>
            <button type="button" class="secondary-button" :disabled="autofillStatus === 'running'" @click="fillFixture">使用{{ currentBusiness?.fixtureName }}</button>
          </section>

          <section v-if="activeSession?.status === 'recognizing' && ocrProgress" class="progress-card" aria-live="polite">
            <div class="section-heading"><div><p class="eyebrow">UNIT DOCUMENT BATCH</p><h3>正在合并识别单位资料</h3></div><strong>{{ ocrProgressPercent }}%</strong></div>
            <div class="progress-track"><span :style="{ width: `${ocrProgressPercent}%` }"></span></div>
            <p>{{ ocrProgress.message }}</p><small>会话 {{ activeSession.sessionId.slice(0, 8) }} · {{ currentBusiness?.name }}</small>
          </section>

          <section v-if="batchItems.length" class="review-section batch-file-card">
            <div class="section-title-row"><h3>单位资料文件</h3><small>共 {{ batchItems.length }} 个</small></div>
            <div class="batch-file-list">
              <article v-for="(item, index) in batchItems" :key="item.id" :data-status="item.status">
                <span>{{ index + 1 }}</span>
                <div><strong>{{ item.fileName }}</strong><small>{{ item.message }}</small></div>
                <em>{{ item.status === 'queued' ? '等待识别' : item.status === 'recognizing' ? '识别中' : item.status === 'completed' ? '识别成功' : '识别失败' }}</em>
              </article>
            </div>
          </section>

          <section v-if="activeSession?.status === 'failed'" class="result-state" data-error="true">
            <strong>识别未完成</strong><p>{{ ocrResult?.message ?? '当前会话处理失败' }}</p>
            <button v-if="failedBatchItems.length" type="button" class="secondary-button" @click="retryFailedDocuments">重试失败文件</button>
            <button type="button" class="secondary-button" @click="selectDocument()">重新选择资料</button>
          </section>

          <template v-if="extractedData && activeSession && ['reviewing', 'filling', 'completed'].includes(activeSession.status)">
            <section class="review-summary">
              <p class="session-cache-note">识别结果已暂存，可重复代填；关闭此 ERP 单据页后自动清除。</p>
              <div class="section-heading">
                <div><p class="eyebrow">REVIEW BEFORE AUTOFILL</p><h3>核对识别结果</h3></div>
                <span :data-ready="extractedData.readyForAutofill">{{ extractedData.readyForAutofill ? '可以代填' : '信息不完整' }}</span>
              </div>
              <div class="summary-metrics">
                <div><small>字段覆盖</small><strong>{{ ocrResult?.result?.coveragePercent }}%</strong></div>
                <div><small>已识别字段</small><strong>{{ extractedData.recognizedFieldCount }}</strong></div>
                <div><small>明细数量</small><strong>{{ extractedData.documentType === 'unit-initial-approval' ? extractedData.qualificationRows.length : extractedData.items.length }}</strong></div>
              </div>
            </section>

            <section class="review-section">
              <div class="section-title-row"><h3>基本信息</h3><small>OCR → ERP</small></div>
              <div class="field-review-list">
                <article v-for="field in reviewFields" :key="field.target" :data-status="field.status">
                  <div><strong>{{ field.label }}</strong><small>{{ field.target }}</small></div><span>{{ field.value }}</span>
                  <em>{{ field.status === 'ready' ? '可填写' : field.status === 'match' ? '待匹配' : field.status === 'review' ? '需复核' : '缺失' }}</em>
                </article>
              </div>
            </section>

            <section class="review-section">
              <div class="section-title-row"><h3>{{ extractedData.documentType === 'unit-initial-approval' ? '证照资料' : '商品明细' }}</h3><small>{{ extractedData.documentType === 'purchase-order' ? '通过 ERP 商品参照匹配' : extractedData.documentType === 'goods-receipt' ? '按票据逐行新增并填写' : '将写入资料网格' }}</small></div>
              <div v-if="extractedData.documentType === 'goods-receipt'" class="detail-list">
                <article v-for="(item, index) in (extractedData as GoodsReceiptExtraction).items" :key="`${item.productName}-${item.batchNumber}-${index}`">
                  <div><span>{{ index + 1 }}</span><strong>{{ item.productName }}</strong><em>{{ activeSession.status === 'completed' ? '已代填' : '待代填' }}</em></div>
                  <p>{{ item.specification || '规格未识别' }} · {{ item.manufacturer || '生产企业未识别' }}</p>
                  <small>批号 {{ item.batchNumber || '—' }}　到货 {{ item.arrivalQuantity ?? '—' }} {{ item.unit || '' }}　有效期 {{ item.expiryDate || '—' }}</small>
                </article>
              </div>
              <div v-else-if="extractedData.documentType === 'purchase-order'" class="detail-list">
                <article v-for="(item, index) in (extractedData as PurchaseOrderExtraction).items" :key="`${item.productName}-${item.specification}-${index}`">
                  <div><span>{{ index + 1 }}</span><strong>{{ item.productName }}</strong><em>待参照匹配</em></div>
                  <p>{{ item.specification || '规格未识别' }} · {{ item.manufacturer || '生产企业未识别' }}</p>
                  <small>数量 {{ item.quantity ?? '—' }} {{ item.unit || '' }}　含税单价 {{ item.taxIncludedUnitPrice ?? '—' }}　金额 {{ item.taxIncludedAmount ?? '—' }}　批号 {{ item.batchNumber || '—' }}</small>
                </article>
              </div>
              <div v-else class="detail-list">
                <article v-for="(row, index) in (extractedData as UnitInitialApprovalExtraction).qualificationRows" :key="`${row.dataType}-${row.certificateNo}-${index}`">
                  <div><span>{{ index + 1 }}</span><strong>{{ row.dataType || '未命名资料' }}</strong><em>可填写</em></div>
                  <p>{{ row.certificateNo || '证书编号未识别' }}</p>
                  <small>{{ row.issuingAuthority || '发证机关未识别' }}　{{ row.expiryDate ? `有效期至 ${row.expiryDate}` : '未识别到期日' }}</small>
                </article>
              </div>
            </section>

            <details v-if="extractedData.reviewRequired.length" class="issues-card" open>
              <summary>需要注意（{{ extractedData.reviewRequired.length }}）</summary>
              <p v-for="item in extractedData.reviewRequired" :key="item">{{ item }}</p>
            </details>
            <div v-if="failedBatchItems.length" class="notice" data-error="true">
              <strong>{{ failedBatchItems.length }} 个文件未能识别</strong>
              <span>其他文件的结果已经合并，可重试失败文件后再代填。</span>
              <button type="button" class="secondary-button" @click="retryFailedDocuments">只重试失败文件</button>
            </div>
            <details v-if="ocrResult?.result" class="ocr-details">
              <summary>查看 OCR 原文和处理详情</summary>
              <p v-for="warning in ocrResult.result.warnings" :key="warning" class="warning-text">{{ warning }}</p>
              <details v-for="page in ocrResult.result.pages" :key="page.pageNumber">
                <summary>第 {{ page.pageNumber }} 页 · {{ page.source === 'pi-ocr' ? 'OCR' : page.source === 'skipped-user' ? '用户已排除' : '异常页已跳过' }}</summary>
                <pre>{{ page.text || '该页没有可用 OCR 文字' }}</pre>
              </details>
            </details>
          </template>
        </template>

        <div v-if="erpState.message" class="notice" :data-error="erpState.status === 'error'">{{ erpState.message }}</div>
        <div v-if="autofillResult && !isQueueBusinessPage" class="notice" :data-error="autofillStatus === 'error'" aria-live="polite">
          <strong>{{ autofillStatus === 'success' ? '代填完成' : '代填未完成' }}</strong><span>{{ autofillResult.message }}</span>
          <small v-if="autofillResult.skippedFields.length">未填：{{ autofillResult.skippedFields.join('、') }}</small>
        </div>

        <footer v-if="!isQueueBusinessPage && activeSession?.status === 'reviewing'" class="action-bar">
          <button type="button" class="secondary-button" @click="selectDocument()">重新选择</button>
          <button v-if="failedBatchItems.length" type="button" class="secondary-button" @click="retryFailedDocuments">重试失败文件</button>
          <button type="button" class="primary-button" :disabled="!canConfirmAutofill" @click="confirmAutofill">{{ autofillResult && autofillResult.status !== 'filled' ? '重试代填' : '确认并代填' }}</button>
        </footer>
        <footer v-else-if="!isQueueBusinessPage && activeSession?.status === 'completed'" class="action-bar completed-action">
          <span>已代填，请在 ERP 中核对后手动保存。误删内容可直接重新代填，无需再次识别。</span>
          <button type="button" class="secondary-button" @click="selectDocument()">新任务</button>
          <button type="button" class="primary-button" :disabled="!canConfirmAutofill" @click="confirmAutofill">重新代填</button>
        </footer>
      </div>
    </aside>

  </main>
</template>
