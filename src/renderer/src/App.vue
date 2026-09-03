<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  BUSINESS_DEFINITIONS,
  type BusinessId,
  type GoodsReceiptExtraction,
  type PurchaseOrderExtraction,
  type UnitInitialApprovalExtraction,
  type WorkflowSession
} from '../../shared/business'
import type { ErpAutofillResult, ErpState } from '../../shared/erp'
import type { OcrClientResult, OcrDocumentPreview, OcrProgress } from '../../shared/ocr'

interface ClientWorkflowSession extends WorkflowSession {
  preview: OcrDocumentPreview | null
  selectedPageNumbers: number[]
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
const erpState = ref<ErpState>({
  configured: false,
  status: 'not-configured',
  url: null,
  canGoBack: false,
  canGoForward: false,
  message: null,
  currentPage: null
})
const assistantCollapsed = ref(false)
const sessions = ref<Record<string, ClientWorkflowSession>>({})
const activeSessionId = ref<string | null>(null)
const focusedPreviewPage = ref<OcrDocumentPreview['pages'][number] | null>(null)
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
const currentBusiness = computed(() => {
  const businessId = currentBusinessId.value
  return businessId ? BUSINESS_DEFINITIONS[businessId] : null
})
const currentPageReady = computed(
  () => Boolean(erpState.value.currentPage?.supported && erpState.value.currentPage?.isNew)
)
const activeSession = computed(() => {
  const sessionId = activeSessionId.value
  if (!sessionId) return null
  const session = sessions.value[sessionId] ?? null
  return session?.businessId === currentBusinessId.value ? session : null
})
const currentPreview = computed(() => activeSession.value?.preview ?? null)
const selectedPageNumbers = computed(() => activeSession.value?.selectedPageNumbers ?? [])
const selectedPageCount = computed(() => selectedPageNumbers.value.length)
const excludedPageNumbers = computed(() => {
  const selected = new Set(selectedPageNumbers.value)
  return currentPreview.value?.pages
    .map((page) => page.pageNumber)
    .filter((pageNumber) => !selected.has(pageNumber)) ?? []
})
const canStartExtraction = computed(
  () => currentPreview.value !== null && selectedPageCount.value > 0
)
const recognitionRunning = computed(
  () => activeSession.value?.status === 'previewing' || activeSession.value?.status === 'recognizing'
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
  if (!status || status === 'ready' || status === 'previewing') return 1
  if (status === 'recognizing') return 2
  if (status === 'reviewing' || status === 'failed') return 3
  return 4
})
const canConfirmAutofill = computed(
  () => Boolean(
    activeSession.value?.status === 'reviewing' &&
      extractedData.value?.readyForAutofill &&
      currentPageReady.value &&
      extractedData.value.documentType === currentBusinessId.value
  )
)
const workflowSteps = [
  { number: 1, label: '选择票据' },
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
      { label: '供应商', target: '单位名称 · DWMC', value: displayValue(header.supplierName), status: header.supplierName ? 'match' : 'missing' },
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
    status: 'ready',
    createdAt: Date.now(),
    preview: null,
    selectedPageNumbers: [],
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
  if (!businessId || !currentPageReady.value) return
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

async function selectDocument(): Promise<void> {
  const businessId = currentBusinessId.value
  if (!businessId || !currentPageReady.value) return
  const session = createSession(businessId)
  autofillResult.value = null
  patchSession(session.sessionId, {
    status: 'previewing',
    progress: {
      sessionId: session.sessionId, businessId, stage: 'queued', current: 0, total: 0,
      message: '选择票据后将在本地生成页面预览'
    }
  })
  try {
    const result = await window.desktop.ocr.selectDocument({ sessionId: session.sessionId, businessId })
    if (result.status === 'cancelled') {
      patchSession(session.sessionId, { status: 'ready', progress: null })
      return
    }
    if (result.status === 'failed' || !result.preview) {
      patchSession(session.sessionId, {
        status: 'failed', progress: null,
        result: { status: 'failed', message: result.message, result: null }
      })
      return
    }
    if (result.preview.businessId !== businessId || result.preview.sessionId !== session.sessionId) {
      throw new Error('预览结果与当前业务会话不一致')
    }
    patchSession(session.sessionId, {
      status: 'previewing', preview: result.preview,
      selectedPageNumbers: result.preview.pages.map((page) => page.pageNumber), progress: null
    })
  } catch (error) {
    patchSession(session.sessionId, {
      status: 'failed', progress: null,
      result: { status: 'failed', message: error instanceof Error ? error.message : 'OCR 请求失败', result: null }
    })
  }
}

function togglePreviewPage(pageNumber: number, selected: boolean): void {
  const session = activeSession.value
  if (!session) return
  const next = new Set(session.selectedPageNumbers)
  if (selected) next.add(pageNumber)
  else next.delete(pageNumber)
  patchSession(session.sessionId, { selectedPageNumbers: [...next].sort((a, b) => a - b) })
}

function handlePreviewPageChange(pageNumber: number, event: Event): void {
  const input = event.target
  if (input instanceof HTMLInputElement) togglePreviewPage(pageNumber, input.checked)
}

function selectAllPreviewPages(): void {
  const session = activeSession.value
  if (session?.preview) patchSession(session.sessionId, { selectedPageNumbers: session.preview.pages.map((page) => page.pageNumber) })
}

function excludeAllPreviewPages(): void {
  const session = activeSession.value
  if (session) patchSession(session.sessionId, { selectedPageNumbers: [] })
}

function cancelDocumentPreview(): void {
  const session = activeSession.value
  if (!session?.preview) return
  const request = { sessionId: session.sessionId, businessId: session.businessId, token: session.preview.token }
  patchSession(session.sessionId, { status: 'ready', preview: null, selectedPageNumbers: [], progress: null })
  focusedPreviewPage.value = null
  void window.desktop.ocr.cancelDocument(request)
}

async function startExtraction(): Promise<void> {
  const session = activeSession.value
  const preview = session?.preview
  if (!session || !preview || selectedPageCount.value === 0) return
  const excludedPages = [...excludedPageNumbers.value]
  patchSession(session.sessionId, {
    status: 'recognizing', preview: null, selectedPageNumbers: [], result: null,
    progress: {
      sessionId: session.sessionId, businessId: session.businessId, stage: 'queued', current: 0,
      total: preview.pageCount,
      message: excludedPages.length ? `已在本地排除 ${excludedPages.length} 页，等待开始识别` : '等待开始识别'
    }
  })
  focusedPreviewPage.value = null
  try {
    const result = await window.desktop.ocr.extractDocument({
      sessionId: session.sessionId, businessId: session.businessId,
      token: preview.token, excludedPages
    })
    if (result.result && result.result.businessId !== session.businessId) throw new Error('识别结果与当前业务会话不一致')
    patchSession(session.sessionId, { status: result.status === 'completed' ? 'reviewing' : 'failed', result })
  } catch (error) {
    patchSession(session.sessionId, {
      status: 'failed',
      result: { status: 'failed', message: error instanceof Error ? error.message : 'OCR 请求失败', result: null }
    })
  }
}

async function confirmAutofill(): Promise<void> {
  const session = activeSession.value
  if (!session || !canConfirmAutofill.value) return
  patchSession(session.sessionId, { status: 'filling' })
  autofillStatus.value = 'running'
  autofillResult.value = null
  try {
    const result = await window.desktop.erp.fillSession({ sessionId: session.sessionId, businessId: session.businessId })
    autofillResult.value = result
    autofillStatus.value = result.status === 'filled' ? 'success' : 'error'
    patchSession(session.sessionId, { status: result.status === 'filled' ? 'completed' : 'reviewing' })
  } catch (error) {
    autofillResult.value = {
      status: 'failed', message: error instanceof Error ? error.message : '代填失败',
      filledHeaderFields: 0, filledDetailRows: 0, skippedFields: []
    }
    autofillStatus.value = 'error'
    patchSession(session.sessionId, { status: 'reviewing' })
  }
}

onMounted(async () => {
  erpState.value = await window.desktop.erp.getState()
  await window.desktop.erp.setAssistantWidth(400)
  window.desktop.erp.onStateChanged((state) => {
    const previousSession = activeSessionId.value ? sessions.value[activeSessionId.value] : null
    erpState.value = state
    if (previousSession && state.currentPage?.businessId !== previousSession.businessId) {
      activeSessionId.value = null
      focusedPreviewPage.value = null
      autofillResult.value = null
      autofillStatus.value = 'idle'
    }
  })
  window.desktop.ocr.onProgress((progress) => {
    const session = sessions.value[progress.sessionId]
    if (session?.businessId === progress.businessId) patchSession(progress.sessionId, { progress })
  })
})
</script>

<template>
  <main class="app-shell" :data-assistant-collapsed="assistantCollapsed">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-mark">E</span>
        <div><strong>ERP 票据助手</strong><small>{{ platform }} · BUSINESS WORKBENCH</small></div>
      </div>
      <nav class="navigation" aria-label="ERP 页面导航">
        <button type="button" aria-label="后退" :disabled="!erpState.canGoBack" @click="goBack">←</button>
        <button type="button" aria-label="前进" :disabled="!erpState.canGoForward" @click="goForward">→</button>
        <button type="button" aria-label="刷新" :disabled="!erpState.configured" @click="reload">↻</button>
      </nav>
      <div class="address" :title="erpState.url ?? ''">{{ erpState.url ?? '尚未配置 ERP 地址' }}</div>
      <span v-if="currentBusiness" class="business-badge">{{ currentBusiness.name }}</span>
      <span class="connection" :data-status="erpState.status">{{ statusLabel }}</span>
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
        <header class="context-card" :data-supported="currentPageReady">
          <div>
            <p class="eyebrow">CURRENT ERP PAGE</p>
            <h2>{{ currentBusiness?.name ?? '等待识别业务页面' }}</h2>
            <p v-if="currentBusiness">{{ currentBusiness.moduleName }} · {{ erpState.currentPage?.isNew ? '新建' : '非新建状态' }}</p>
            <p v-else>请在 ERP 中进入已经支持的业务新建页面。</p>
          </div>
          <span>{{ currentPageReady ? '已就绪' : '不可代填' }}</span>
        </header>

        <ol class="workflow-steps" aria-label="票据处理步骤">
          <li v-for="step in workflowSteps" :key="step.number" :data-active="workflowStep === step.number" :data-completed="workflowStep > step.number">
            <span>{{ workflowStep > step.number ? '✓' : step.number }}</span><small>{{ step.label }}</small>
          </li>
        </ol>

        <section v-if="!currentPageReady" class="panel-state">
          <div class="state-icon">⌁</div><strong>当前页面没有可用的代填任务</strong>
          <p>进入以下任一业务的新建页后，助手会自动切换，不会沿用其他业务的数据。</p>
          <div class="supported-businesses">
            <article v-for="business in BUSINESS_DEFINITIONS" :key="business.id">
              <strong>{{ business.name }}</strong><small>{{ business.description }}</small>
            </article>
          </div>
        </section>

        <template v-else>
          <section v-if="!activeSession || activeSession.status === 'ready'" class="intake-card">
            <p class="eyebrow">DOCUMENT INTAKE</p><h3>选择{{ currentBusiness?.documentName }}</h3>
            <p>文件与结果只保存在“{{ currentBusiness?.name }}”会话中，切换业务后不会继续使用。</p>
            <button type="button" class="primary-button" :disabled="recognitionRunning" @click="selectDocument">选择票据并筛选页面</button>
            <button type="button" class="secondary-button" :disabled="autofillStatus === 'running'" @click="fillFixture">使用{{ currentBusiness?.fixtureName }}</button>
          </section>

          <section v-if="activeSession?.status === 'previewing' && !currentPreview" class="progress-card local-preview-progress" aria-live="polite" aria-busy="true">
            <div class="section-heading">
              <div><p class="eyebrow">LOCAL DOCUMENT PREVIEW</p><h3>{{ ocrProgress?.stage === 'rendering' ? '正在本地渲染页面' : '正在准备本地预览' }}</h3></div>
              <strong>{{ ocrProgressPercent }}%</strong>
            </div>
            <div class="progress-track"><span :style="{ width: `${ocrProgressPercent}%` }"></span></div>
            <p>{{ ocrProgress?.message ?? '正在读取文件并准备页面预览' }}</p>
            <small>此阶段仅在本机生成缩略图，文件尚未发送给 OCR 模型</small>
          </section>

          <section v-if="activeSession?.status === 'recognizing' && ocrProgress" class="progress-card" aria-live="polite">
            <div class="section-heading"><div><p class="eyebrow">OCR PIPELINE</p><h3>正在识别{{ currentBusiness?.documentName }}</h3></div><strong>{{ ocrProgressPercent }}%</strong></div>
            <div class="progress-track"><span :style="{ width: `${ocrProgressPercent}%` }"></span></div>
            <p>{{ ocrProgress.message }}</p><small>会话 {{ activeSession.sessionId.slice(0, 8) }} · {{ currentBusiness?.name }}</small>
          </section>

          <section v-if="activeSession?.status === 'failed'" class="result-state" data-error="true">
            <strong>识别未完成</strong><p>{{ ocrResult?.message ?? '当前会话处理失败' }}</p>
            <button type="button" class="secondary-button" @click="selectDocument">重新选择票据</button>
          </section>

          <template v-if="extractedData && activeSession && ['reviewing', 'filling', 'completed'].includes(activeSession.status)">
            <section class="review-summary">
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
              <div class="section-title-row"><h3>{{ extractedData.documentType === 'unit-initial-approval' ? '证照资料' : '商品明细' }}</h3><small>{{ extractedData.documentType === 'purchase-order' ? '通过 ERP 商品参照匹配' : extractedData.documentType === 'goods-receipt' ? '需匹配 ERP 订单行' : '将写入资料网格' }}</small></div>
              <div v-if="extractedData.documentType === 'goods-receipt'" class="detail-list">
                <article v-for="(item, index) in (extractedData as GoodsReceiptExtraction).items" :key="`${item.productName}-${item.batchNumber}-${index}`">
                  <div><span>{{ index + 1 }}</span><strong>{{ item.productName }}</strong><em>待匹配</em></div>
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
        <div v-if="autofillResult" class="notice" :data-error="autofillStatus === 'error'" aria-live="polite">
          <strong>{{ autofillStatus === 'success' ? '代填完成' : '代填未完成' }}</strong><span>{{ autofillResult.message }}</span>
          <small v-if="autofillResult.skippedFields.length">未填：{{ autofillResult.skippedFields.join('、') }}</small>
        </div>

        <footer v-if="activeSession?.status === 'reviewing'" class="action-bar">
          <button type="button" class="secondary-button" @click="selectDocument">重新选择</button>
          <button type="button" class="primary-button" :disabled="!canConfirmAutofill" @click="confirmAutofill">确认并代填</button>
        </footer>
        <footer v-else-if="activeSession?.status === 'completed'" class="action-bar completed-action">
          <span>已代填，请在 ERP 中核对后手动保存</span><button type="button" class="secondary-button" @click="selectDocument">新任务</button>
        </footer>
      </div>
    </aside>

    <div v-if="currentPreview" class="preview-backdrop" role="presentation" @click.self="cancelDocumentPreview">
      <section class="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <header class="preview-header">
          <div><p class="eyebrow">LOCAL PRIVACY FILTER · {{ currentBusiness?.name }}</p><h2 id="preview-title">上传前排除高敏页面</h2><p>{{ currentPreview.fileName }} · 共 {{ currentPreview.pageCount }} 页</p></div>
          <button type="button" aria-label="关闭页面筛选" @click="cancelDocumentPreview">×</button>
        </header>
        <div class="privacy-guidance"><strong>缩略图仅在本机生成</strong><span>取消勾选身份证、护照、银行卡、人脸证件照等高敏页面；被排除页面不会发送给模型。</span></div>
        <div class="preview-controls"><span>将识别 {{ selectedPageCount }} 页，排除 {{ excludedPageNumbers.length }} 页</span><div><button type="button" @click="selectAllPreviewPages">全选</button><button type="button" @click="excludeAllPreviewPages">全部排除</button></div></div>
        <div class="preview-grid">
          <article v-for="page in currentPreview.pages" :key="page.pageNumber" class="preview-page" :data-selected="selectedPageNumbers.includes(page.pageNumber)">
            <label class="preview-page-toggle"><input type="checkbox" :checked="selectedPageNumbers.includes(page.pageNumber)" @change="handlePreviewPageChange(page.pageNumber, $event)" /><img :src="page.thumbnailDataUrl" :alt="`第 ${page.pageNumber} 页本地预览`" /><span>第 {{ page.pageNumber }} 页</span><small>{{ selectedPageNumbers.includes(page.pageNumber) ? '将发送识别' : '仅本地排除' }}</small></label>
            <button type="button" class="preview-zoom-button" @click.prevent.stop="focusedPreviewPage = page">查看大图</button>
          </article>
        </div>
        <footer class="preview-footer"><button type="button" class="preview-cancel" @click="cancelDocumentPreview">取消</button><button type="button" class="preview-confirm" :disabled="!canStartExtraction" @click="startExtraction">开始识别 {{ selectedPageCount }} 页</button></footer>
        <div v-if="focusedPreviewPage" class="preview-focus-backdrop" role="presentation" @click.self="focusedPreviewPage = null">
          <section class="preview-focus" role="dialog" aria-modal="true">
            <header><strong>第 {{ focusedPreviewPage.pageNumber }} 页本地预览</strong><button type="button" aria-label="关闭大图" @click="focusedPreviewPage = null">×</button></header>
            <img :src="focusedPreviewPage.thumbnailDataUrl" :alt="`第 ${focusedPreviewPage.pageNumber} 页放大预览`" />
            <footer><span>{{ selectedPageNumbers.includes(focusedPreviewPage.pageNumber) ? '当前将发送给 OCR' : '当前仅在本地排除' }}</span><button type="button" :data-exclude="selectedPageNumbers.includes(focusedPreviewPage.pageNumber)" @click="togglePreviewPage(focusedPreviewPage.pageNumber, !selectedPageNumbers.includes(focusedPreviewPage.pageNumber))">{{ selectedPageNumbers.includes(focusedPreviewPage.pageNumber) ? '排除此页' : '恢复此页' }}</button></footer>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
