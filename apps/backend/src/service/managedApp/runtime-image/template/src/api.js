/**
 * 模型免操心路径封装：自动基于 import.meta.env.BASE_URL 拼接应用网关前缀
 */
let currentCsrfToken = null

export function setCsrfToken(token) {
  currentCsrfToken = token || null
}

export function resolveAppUrl(relPath) {
  const base = (import.meta.env?.BASE_URL || './').replace(/\/?$/, '/')
  const clean = String(relPath || '').replace(/^\/+/, '')
  return `${base}${clean}`
}

export async function apiFetch(relPath, options = {}) {
  const headers = new Headers(options.headers || {})
  if (
    options.body &&
    typeof options.body === 'string' &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json')
  }
  if (currentCsrfToken && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', currentCsrfToken)
  }

  const res = await fetch(resolveAppUrl(relPath), {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  const contentType = res.headers.get('content-type') || ''
  const data = contentType.includes('application/json')
    ? await res.json()
    : await res.text()

  if (!res.ok) {
    const msg =
      typeof data === 'object' && data?.error?.message
        ? data.error.message
        : `HTTP ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export function openAppEvents(relPath = 'events') {
  return new EventSource(resolveAppUrl(relPath), { withCredentials: true })
}
