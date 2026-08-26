export interface ErpConfig {
  url: URL | null
  allowedOrigins: ReadonlySet<string>
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value)

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null
    }

    return url.origin
  } catch {
    return null
  }
}

export function loadErpConfig(): ErpConfig {
  const configuredUrl = import.meta.env.MAIN_VITE_ERP_URL?.trim()

  if (!configuredUrl) {
    return {
      url: null,
      allowedOrigins: new Set()
    }
  }

  let url: URL

  try {
    url = new URL(configuredUrl)
  } catch {
    console.error('MAIN_VITE_ERP_URL 不是有效的网址')

    return {
      url: null,
      allowedOrigins: new Set()
    }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    console.error('MAIN_VITE_ERP_URL 只支持 HTTP 或 HTTPS')

    return {
      url: null,
      allowedOrigins: new Set()
    }
  }

  if (url.protocol === 'http:') {
    console.warn('ERP 当前使用 HTTP，生产环境建议切换为 HTTPS')
  }

  const allowedOrigins = new Set<string>([url.origin])
  const additionalOrigins = import.meta.env.MAIN_VITE_ALLOWED_ORIGINS ?? ''

  for (const item of additionalOrigins.split(',')) {
    const origin = parseOrigin(item.trim())

    if (origin) {
      allowedOrigins.add(origin)
    }
  }

  return {
    url,
    allowedOrigins
  }
}
