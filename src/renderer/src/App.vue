<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ErpAutofillResult, ErpState } from '../../shared/erp'
import type { OcrClientResult, OcrDocumentPreview, OcrProgress } from '../../shared/ocr'

const platform = window.desktop.platform
const erpState = ref<ErpState>({
  configured: false,
  status: 'not-configured',
  url: null,
  canGoBack: false,
  canGoForward: false,
  message: null
})
const autofillStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
const autofillResult = ref<ErpAutofillResult | null>(null)
const ocrStatus = ref<'idle' | 'running' | 'success' | 'error'>('idle')
const ocrProgress = ref<OcrProgress | null>(null)
const ocrResult = ref<OcrClientResult | null>(null)
const ocrPreview = ref<OcrDocumentPreview | null>(null)
const selectedPageNumbers = ref<number[]>([])
const focusedPreviewPage = ref<OcrDocumentPreview['pages'][number] | null>(null)

const statusLabel = computed(() => {
  const labels: Record<ErpState['status'], string> = {
    'not-configured': '待配置',
    loading: '正在加载',
    ready: '已连接',
    error: '加载失败'
  }

  return labels[erpState.value.status]
})

const canFillMockData = computed(
  () =>
    erpState.value.configured &&
    erpState.value.status !== 'error' &&
    autofillStatus.value !== 'running'
)

const extractedData = computed(() => ocrResult.value?.result?.extractedData ?? null)

const ocrProgressPercent = computed(() => {
  const progress = ocrProgress.value
  if (!progress) return 0
  if (progress.stage === 'completed') return 100
  if (progress.total <= 0) return 8
  return Math.max(8, Math.min(96, Math.round((progress.current / progress.total) * 100)))
})

const selectedPageCount = computed(() => selectedPageNumbers.value.length)

const excludedPageNumbers = computed(() => {
  const selected = new Set(selectedPageNumbers.value)
  return ocrPreview.value?.pages
    .map((page) => page.pageNumber)
    .filter((pageNumber) => !selected.has(pageNumber)) ?? []
})

const canStartExtraction = computed(
  () => ocrPreview.value !== null && selectedPageCount.value > 0
)

function goBack(): void {
  void window.desktop.erp.goBack()
}

function goForward(): void {
  void window.desktop.erp.goForward()
}

function reload(): void {
  void window.desktop.erp.reload()
}

async function fillMockData(): Promise<void> {
  autofillStatus.value = 'running'
  autofillResult.value = null

  try {
    const result = await window.desktop.erp.fillMockData()
    autofillResult.value = result
    autofillStatus.value = result.status === 'filled' ? 'success' : 'error'
  } catch (error) {
    autofillResult.value = {
      status: 'failed',
      message: error instanceof Error ? error.message : '代填请求失败',
      filledHeaderFields: 0,
      filledQualificationRows: 0,
      skippedFields: []
    }
    autofillStatus.value = 'error'
  }
}

async function selectDocument(): Promise<void> {
  ocrStatus.value = 'running'
  ocrResult.value = null
  ocrPreview.value = null
  selectedPageNumbers.value = []
  focusedPreviewPage.value = null
  ocrProgress.value = {
    stage: 'queued',
    current: 0,
    total: 0,
    message: '选择票据后将在本地生成页面预览'
  }

  try {
    const result = await window.desktop.ocr.selectDocument()

    if (result.status === 'cancelled') {
      ocrStatus.value = 'idle'
      ocrProgress.value = null
      return
    }
    if (result.status === 'failed' || !result.preview) {
      ocrResult.value = { status: 'failed', message: result.message, result: null }
      ocrStatus.value = 'error'
      ocrProgress.value = null
      return
    }

    ocrPreview.value = result.preview
    selectedPageNumbers.value = result.preview.pages.map((page) => page.pageNumber)
    ocrStatus.value = 'idle'
    ocrProgress.value = null
  } catch (error) {
    ocrResult.value = {
      status: 'failed',
      message: error instanceof Error ? error.message : 'OCR 请求失败',
      result: null
    }
    ocrStatus.value = 'error'
  }
}

function togglePreviewPage(pageNumber: number, selected: boolean): void {
  const next = new Set(selectedPageNumbers.value)
  if (selected) next.add(pageNumber)
  else next.delete(pageNumber)
  selectedPageNumbers.value = [...next].sort((left, right) => left - right)
}

function handlePreviewPageChange(pageNumber: number, event: Event): void {
  const input = event.target
  if (input instanceof HTMLInputElement) togglePreviewPage(pageNumber, input.checked)
}

function selectAllPreviewPages(): void {
  selectedPageNumbers.value = ocrPreview.value?.pages.map((page) => page.pageNumber) ?? []
}

function excludeAllPreviewPages(): void {
  selectedPageNumbers.value = []
}

function cancelDocumentPreview(): void {
  const token = ocrPreview.value?.token
  ocrPreview.value = null
  selectedPageNumbers.value = []
  focusedPreviewPage.value = null
  if (token) void window.desktop.ocr.cancelDocument(token)
}

async function startExtraction(): Promise<void> {
  const preview = ocrPreview.value
  if (!preview || selectedPageCount.value === 0) return

  const excludedPages = [...excludedPageNumbers.value]
  ocrPreview.value = null
  selectedPageNumbers.value = []
  focusedPreviewPage.value = null
  ocrStatus.value = 'running'
  ocrResult.value = null
  ocrProgress.value = {
    stage: 'queued',
    current: 0,
    total: preview.pageCount,
    message:
      excludedPages.length > 0
        ? `已在本地排除 ${excludedPages.length} 页，等待开始识别`
        : '等待开始识别'
  }

  try {
    const result = await window.desktop.ocr.extractDocument({
      token: preview.token,
      excludedPages
    })
    ocrResult.value = result
    ocrStatus.value = result.status === 'completed' ? 'success' : 'error'
  } catch (error) {
    ocrResult.value = {
      status: 'failed',
      message: error instanceof Error ? error.message : 'OCR 请求失败',
      result: null
    }
    ocrStatus.value = 'error'
  }
}

onMounted(async () => {
  erpState.value = await window.desktop.erp.getState()
  window.desktop.erp.onStateChanged((state) => {
    erpState.value = state
  })
  window.desktop.ocr.onProgress((progress) => {
    ocrProgress.value = progress
  })
})
</script>

<template>
  <main class="app-shell">
    <header class="toolbar">
      <div class="brand">
        <span class="brand-mark">E</span>
        <div>
          <strong>ERP 票据助手</strong>
          <small>{{ platform }}</small>
        </div>
      </div>

      <nav class="navigation" aria-label="ERP 页面导航">
        <button
          type="button"
          aria-label="后退"
          :disabled="!erpState.canGoBack"
          @click="goBack"
        >
          ←
        </button>
        <button
          type="button"
          aria-label="前进"
          :disabled="!erpState.canGoForward"
          @click="goForward"
        >
          →
        </button>
        <button
          type="button"
          aria-label="刷新"
          :disabled="!erpState.configured"
          @click="reload"
        >
          ↻
        </button>
      </nav>

      <div class="address" :title="erpState.url ?? ''">
        {{ erpState.url ?? '尚未配置 ERP 地址' }}
      </div>

      <span class="connection" :data-status="erpState.status">
        {{ statusLabel }}
      </span>
    </header>

    <section class="erp-stage">
      <div v-if="!erpState.configured" class="empty-state">
        <p class="eyebrow">ERP URL REQUIRED</p>
        <h1>配置 ERP 地址</h1>
        <p>复制 <code>.env.example</code> 为 <code>.env</code>，填写 ERP 登录页地址后重新启动。</p>
      </div>
    </section>

    <aside class="assistant-panel">
      <section>
        <p class="eyebrow">RECEIPT ASSISTANT</p>
        <h2>票据识别</h2>
        <p class="panel-copy">选择 PDF 或图片后，先在本地预览并排除身份证等高敏页面。只有保留的页面会发送给 OCR。确认结果后可一键代填，但不会自动保存或提交。</p>
      </section>

      <section class="fixture-card">
        <span class="fixture-tag">测试数据</span>
        <strong>单位首营模拟资料</strong>
        <small>基本字段 + 4 条证照资料</small>
      </section>

      <section v-if="ocrStatus === 'running' && ocrProgress" class="ocr-progress" aria-live="polite">
        <div class="ocr-progress-heading">
          <strong>正在处理票据</strong>
          <span>{{ ocrProgressPercent }}%</span>
        </div>
        <div class="progress-track" aria-hidden="true">
          <span :style="{ width: `${ocrProgressPercent}%` }"></span>
        </div>
        <small>{{ ocrProgress.message }}</small>
      </section>

      <section
        v-if="ocrResult"
        class="ocr-result-card"
        :data-error="ocrStatus === 'error'"
        aria-live="polite"
      >
        <strong>{{ ocrStatus === 'success' ? '识别完成' : '识别失败' }}</strong>
        <p>{{ ocrResult.message }}</p>

        <template v-if="ocrResult.result">
          <dl class="ocr-summary">
            <div><dt>页数</dt><dd>{{ ocrResult.result.pageCount }}</dd></div>
            <div><dt>文本块</dt><dd>{{ ocrResult.result.blockCount }}</dd></div>
            <div>
              <dt>字段覆盖</dt>
              <dd>{{ ocrResult.result.coveragePercent }}%</dd>
            </div>
            <div><dt>耗时</dt><dd>{{ (ocrResult.result.elapsedMs / 1000).toFixed(1) }} 秒</dd></div>
          </dl>

          <p v-for="warning in ocrResult.result.warnings" :key="warning" class="ocr-warning">
            {{ warning }}
          </p>

          <section v-if="extractedData" class="extracted-card">
            <span class="fixture-tag">结构化字段</span>
            <strong>{{ extractedData.header.unitName || '未识别到单位名称' }}</strong>
            <small>
              已识别 {{ extractedData.recognizedFieldCount }} 个基本字段，
              {{ extractedData.qualificationRows.length }} 条证照资料
            </small>
            <p v-if="extractedData.missingRecommendedFields.length > 0" class="ocr-warning">
              建议人工补充：{{ extractedData.missingRecommendedFields.join('、') }}
            </p>
            <p v-for="item in extractedData.reviewRequired" :key="item" class="ocr-warning">
              {{ item }}
            </p>
          </section>

          <div class="ocr-pages">
            <details v-for="page in ocrResult.result.pages" :key="page.pageNumber">
              <summary>
                第 {{ page.pageNumber }} 页 ·
                {{ page.source === 'skipped-user'
                  ? '用户已排除'
                  : page.source === 'skipped-error'
                    ? '异常页已跳过'
                    : 'OCR' }}
              </summary>
              <pre>{{ page.source === 'skipped-user'
                ? '该页在本地排除，未发送给 OCR 或字段标准化模型。'
                : page.source === 'skipped-error'
                  ? '该页因模型重复输出被跳过，部分结果未保存。'
                  : (page.text || '未识别到文字') }}</pre>
            </details>
          </div>
        </template>
      </section>

      <div v-if="erpState.message" class="notice" :data-error="erpState.status === 'error'">
        {{ erpState.message }}
      </div>

      <div
        v-if="autofillResult"
        class="notice autofill-notice"
        :data-error="autofillStatus === 'error'"
        aria-live="polite"
      >
        {{ autofillResult.message }}
        <span v-if="autofillResult.skippedFields.length > 0">
          未填：{{ autofillResult.skippedFields.join('、') }}
        </span>
      </div>

      <div class="assistant-actions">
        <button
          class="upload-button"
          type="button"
          :disabled="ocrStatus === 'running'"
          @click="selectDocument"
        >
          {{ ocrStatus === 'running' ? '正在处理…' : '选择票据并筛选页面' }}
        </button>
        <button
          class="autofill-button"
          type="button"
          :disabled="!canFillMockData"
          @click="fillMockData"
        >
          {{ autofillStatus === 'running' ? '正在填写…' : '使用模拟数据代填' }}
        </button>
      </div>
    </aside>

    <div
      v-if="ocrPreview"
      class="preview-backdrop"
      role="presentation"
      @click.self="cancelDocumentPreview"
    >
      <section
        class="preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
      >
        <header class="preview-header">
          <div>
            <p class="eyebrow">LOCAL PRIVACY FILTER</p>
            <h2 id="preview-title">上传前排除高敏页面</h2>
            <p>{{ ocrPreview.fileName }} · 共 {{ ocrPreview.pageCount }} 页</p>
          </div>
          <button type="button" aria-label="关闭页面筛选" @click="cancelDocumentPreview">×</button>
        </header>

        <div class="privacy-guidance">
          <strong>缩略图仅在本机生成</strong>
          <span>请取消勾选包含身份证、护照、银行卡、人脸证件照等高敏信息的页面。取消后，这些页面不会发送给任何模型。</span>
        </div>

        <div class="preview-controls">
          <span>
            将识别 {{ selectedPageCount }} 页，排除 {{ excludedPageNumbers.length }} 页
          </span>
          <div>
            <button type="button" @click="selectAllPreviewPages">全选</button>
            <button type="button" @click="excludeAllPreviewPages">全部排除</button>
          </div>
        </div>

        <div class="preview-grid">
          <article
            v-for="page in ocrPreview.pages"
            :key="page.pageNumber"
            class="preview-page"
            :data-selected="selectedPageNumbers.includes(page.pageNumber)"
          >
            <label class="preview-page-toggle">
              <input
                type="checkbox"
                :checked="selectedPageNumbers.includes(page.pageNumber)"
                @change="handlePreviewPageChange(page.pageNumber, $event)"
              />
              <img :src="page.thumbnailDataUrl" :alt="`第 ${page.pageNumber} 页本地预览`" />
              <span>第 {{ page.pageNumber }} 页</span>
              <small>
                {{ selectedPageNumbers.includes(page.pageNumber) ? '将发送识别' : '仅本地排除' }}
              </small>
            </label>
            <button
              type="button"
              class="preview-zoom-button"
              @click.prevent.stop="focusedPreviewPage = page"
            >
              查看大图
            </button>
          </article>
        </div>

        <footer class="preview-footer">
          <button type="button" class="preview-cancel" @click="cancelDocumentPreview">取消</button>
          <button
            type="button"
            class="preview-confirm"
            :disabled="!canStartExtraction"
            @click="startExtraction"
          >
            开始识别 {{ selectedPageCount }} 页
          </button>
        </footer>

        <div
          v-if="focusedPreviewPage"
          class="preview-focus-backdrop"
          role="presentation"
          @click.self="focusedPreviewPage = null"
        >
          <section class="preview-focus" role="dialog" aria-modal="true">
            <header>
              <strong>第 {{ focusedPreviewPage.pageNumber }} 页本地预览</strong>
              <button type="button" aria-label="关闭大图" @click="focusedPreviewPage = null">×</button>
            </header>
            <img
              :src="focusedPreviewPage.thumbnailDataUrl"
              :alt="`第 ${focusedPreviewPage.pageNumber} 页放大预览`"
            />
            <footer>
              <span>
                {{ selectedPageNumbers.includes(focusedPreviewPage.pageNumber)
                  ? '当前将发送给 OCR'
                  : '当前仅在本地排除' }}
              </span>
              <button
                type="button"
                :data-exclude="selectedPageNumbers.includes(focusedPreviewPage.pageNumber)"
                @click="togglePreviewPage(
                  focusedPreviewPage.pageNumber,
                  !selectedPageNumbers.includes(focusedPreviewPage.pageNumber)
                )"
              >
                {{ selectedPageNumbers.includes(focusedPreviewPage.pageNumber)
                  ? '排除此页'
                  : '恢复此页' }}
              </button>
            </footer>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
