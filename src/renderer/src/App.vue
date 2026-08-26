<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ErpAutofillResult, ErpState } from '../../shared/erp'

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

onMounted(async () => {
  erpState.value = await window.desktop.erp.getState()
  window.desktop.erp.onStateChanged((state) => {
    erpState.value = state
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
        <p class="panel-copy">进入单位首营审批的新建页后，可以用已提取的柏锦测试数据一键填写。代填不会自动保存或提交。</p>
      </section>

      <section class="fixture-card">
        <span class="fixture-tag">测试数据</span>
        <strong>吉林柏锦医药有限公司</strong>
        <small>基本字段 + 4 条证照资料</small>
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
          class="autofill-button"
          type="button"
          :disabled="!canFillMockData"
          @click="fillMockData"
        >
          {{ autofillStatus === 'running' ? '正在填写…' : '使用模拟数据代填' }}
        </button>
        <button class="upload-button" type="button" disabled>上传票据（待接入 OCR）</button>
      </div>
    </aside>
  </main>
</template>
