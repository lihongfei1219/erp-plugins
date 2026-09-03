const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const DEFAULT_OCR_MODEL = 'qwen3.5-ocr'
const DEFAULT_NORMALIZER_MODEL = 'deepseek-v4-flash-0731'
const SAMPLE_IMAGE_URL =
  'https://img.alicdn.com/imgextra/i2/O1CN01ktT8451iQutqReELT_!!6000000004408-0-tps-689-487.jpg'
const ALLOWED_HOSTS = new Set(['dashscope.aliyuncs.com'])

try {
  process.loadEnvFile('.env')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

function requiredApiKey() {
  const apiKey =
    process.env.DASHSCOPE_API_KEY?.trim() ||
    process.env.PI_API_KEY?.trim() ||
    process.env.PI_OCR_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('缺少 DASHSCOPE_API_KEY、PI_API_KEY 或 PI_OCR_API_KEY 环境变量')
  }
  return apiKey
}

function endpointUrl() {
  const configured = process.env.DASHSCOPE_BASE_URL?.trim() || DEFAULT_BASE_URL
  const baseUrl = new URL(configured)
  const isDedicatedBeijingHost = baseUrl.hostname.endsWith('.cn-beijing.maas.aliyuncs.com')

  if (
    baseUrl.protocol !== 'https:' ||
    (!ALLOWED_HOSTS.has(baseUrl.hostname) && !isDedicatedBeijingHost)
  ) {
    throw new Error(
      'DASHSCOPE_BASE_URL 必须是阿里云百炼北京地域的 HTTPS 公共域名或业务空间专属域名'
    )
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}/chat/completions`
  return baseUrl
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function visibleOcrText(value) {
  const fenced = value.trim().match(/^\s*```(?:html|xml|markdown|md|text)?\s*\n?([\s\S]*?)\n?```\s*$/i)?.[1] ?? value.trim()
  return fenced
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitized(value, apiKey) {
  return String(value).replaceAll(apiKey, '[REDACTED]')
}

async function postJson(endpoint, apiKey, body, label) {
  const startedAt = Date.now()
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  })
  const rawBody = await response.text()
  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    payload = null
  }

  if (!response.ok) {
    const detail = payload?.message || payload?.error?.message || rawBody.slice(0, 1000)
    throw new Error(`${label} HTTP ${response.status}：${sanitized(detail, apiKey)}`)
  }

  return {
    payload,
    elapsedMs: Date.now() - startedAt,
    requestId:
      response.headers.get('x-request-id') || payload?.request_id || payload?.id || '未返回'
  }
}

async function testOcr(endpoint, apiKey) {
  const model = process.env.DASHSCOPE_OCR_MODEL?.trim() || DEFAULT_OCR_MODEL
  console.log(`\n[1/2] 测试 OCR 模型：${model}`)
  const result = await postJson(
    endpoint,
    apiKey,
    {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: SAMPLE_IMAGE_URL } }
          ]
        }
      ],
      max_tokens: 256,
      stream: false
    },
    'Qwen OCR'
  )
  const text = responseText(result.payload)
  if (!text) throw new Error('Qwen OCR 接口成功，但响应中没有 OCR 文本')
  if (!visibleOcrText(text)) {
    throw new Error('Qwen OCR 接口成功，但只返回了 HTML 图片占位符')
  }
  console.log(`成功，耗时 ${result.elapsedMs} ms，请求 ID：${result.requestId}`)
  console.log(`结果预览：${text.replace(/\s+/g, ' ').slice(0, 160)}`)
}

async function testNormalizer(endpoint, apiKey) {
  const model =
    process.env.DASHSCOPE_NORMALIZER_MODEL?.trim() || DEFAULT_NORMALIZER_MODEL
  console.log(`\n[2/2] 测试字段标准化模型及 Function Calling：${model}`)
  const result = await postJson(
    endpoint,
    apiKey,
    {
      model,
      messages: [
        {
          role: 'user',
          content: '请调用 submit_connection_test，并将 connected 参数设为 true。不要输出普通文本。'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'submit_connection_test',
            description: '确认模型能够使用 Function Calling。',
            parameters: {
              type: 'object',
              properties: { connected: { type: 'boolean' } },
              required: ['connected'],
              additionalProperties: false
            }
          }
        }
      ],
      tool_choice: {
        type: 'function',
        function: { name: 'submit_connection_test' }
      },
      enable_thinking: false,
      max_tokens: 256,
      stream: false
    },
    'DeepSeek 标准化模型'
  )

  const toolCall = result.payload?.choices?.[0]?.message?.tool_calls?.[0]
  if (toolCall?.function?.name !== 'submit_connection_test') {
    throw new Error('DeepSeek 请求成功，但没有返回预期的 Function Calling')
  }
  let argumentsPayload
  try {
    argumentsPayload = JSON.parse(toolCall.function.arguments)
  } catch {
    throw new Error('DeepSeek 返回了无法解析的工具参数')
  }
  if (argumentsPayload?.connected !== true) {
    throw new Error('DeepSeek 工具参数校验失败')
  }
  console.log(`成功，耗时 ${result.elapsedMs} ms，请求 ID：${result.requestId}`)
  console.log('Function Calling：submit_connection_test({ connected: true })')
}

async function main() {
  const apiKey = requiredApiKey()
  const endpoint = endpointUrl()
  console.log(`正在连接：${endpoint.origin}${endpoint.pathname}`)
  console.log('Qwen OCR 与 DeepSeek 将使用同一个环境变量 Key。')
  await testOcr(endpoint, apiKey)
  await testNormalizer(endpoint, apiKey)
  console.log('\n两个模型均连接成功。')
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`\n连接失败：${message}`)
  process.exitCode = 1
})
