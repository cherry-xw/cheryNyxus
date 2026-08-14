import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const KEY_ADDR = 'chery.serverAddress'
const KEY_ACCESS = 'chery.accessToken'
const KEY_REFRESH = 'chery.refreshToken'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** 从服务地址中提取 host（小写）。解析失败退化为取 `://` 后第一段。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return url.split('://')[1]?.split(/[/:]/)[0]?.toLowerCase() ?? ''
  }
}

/** 是否为 loopback host（本地直连不鉴权）。 */
export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true
  return host.startsWith('127.') || host.startsWith('::ffff:127.')
}

/** 补全 scheme（用户可能只输入 host:port）。 */
export function normalizeAddress(addr: string): string {
  const trimmed = addr.trim()
  if (!trimmed) return ''
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`
}

/**
 * 登录 / 连接失败的分类信息（用于 UI 渲染分类化错误卡片）。
 *
 * 区分点：
 * - `network`：连接失败（DNS / 拒绝 / 超时），原始 `cause` 是 `TypeError` 且 name === 'AbortError' 之外的 fetch reject
 * - `cors`：明确被浏览器跨域拦截（fetch reject + message 含 CORS / "Failed to fetch" / "NetworkError"）
 * - `timeout`：`AbortError`，用户请求主动取消或超时
 * - `http`：后端返回 4xx/5xx，已拿到响应
 * - `credential`：401 / 403，账号密码错
 * - `unknown`：兜底
 */
export interface AuthError {
  kind: 'network' | 'cors' | 'timeout' | 'http' | 'credential' | 'unknown'
  /** 主标题（短） */
  title: string
  /** 详细描述（长，给用户排查用） */
  detail: string
  /** 可选后端返回的错误码或文案 */
  backendMessage?: string
  /** HTTP 状态（如适用） */
  status?: number
  /** 用于显示原始 throw 对象（折叠行） */
  raw?: unknown
}

/**
 * 把 fetch 抛错 + 后端响应归类为 AuthError。
 * 浏览器 fetch 在跨域/网络断时一律 reject 为 TypeError，需要区分原因。
 */
export function classifyError(cause: unknown, status?: number): AuthError {
  const raw = cause instanceof Error ? cause : new Error(String(cause))
  const msg = raw.message ?? ''
  const lower = msg.toLowerCase()

  // AbortError / TimeoutError：明确超时或取消
  if (raw.name === 'AbortError' || lower.includes('timeout') || lower.includes('aborted')) {
    return {
      kind: 'timeout',
      title: '连接超时',
      detail: '请求在限定时间内未拿到响应，可能是网络慢或后端无响应。可重试或检查网络与防火墙。',
      raw,
    }
  }

  // CORS / fetch failure：浏览器拒绝响应（preflight fail / opaque 跨域）
  const looksCors =
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('cross-origin') ||
    lower.includes('cors')
  if (looksCors) {
    return {
      kind: 'cors',
      title: '跨域请求被浏览器拦截（CORS）',
      detail:
        '浏览器拒绝读取跨源响应。后端未启用 CORS，或访问地址与后端不在同一 origin。建议改用后端同源地址（http://<host>:8183/ 一体化访问），或联系管理员在反向代理层做同源转发。',
      raw,
    }
  }

  // 网络层失败：DNS / 连接拒绝 / 离线
  if (lower.includes('fetch') || lower.includes('econnrefused') || lower.includes('enotfound')) {
    return {
      kind: 'network',
      title: '无法连接到服务器',
      detail:
        '请确认地址与端口可达（本机后端默认 8183），后端进程已启动，防火墙已放行。详见浏览器 Network 面板的状态详情。',
      raw,
    }
  }

  // 有 HTTP 状态：先按状态归类，再回退 http
  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return {
        kind: 'credential',
        title: '登录失败',
        detail: '用户名或密码错误，或账号已被禁用。请重试或联系管理员。',
        status,
        raw,
      }
    }
    if (status >= 500) {
      return {
        kind: 'http',
        title: `后端服务异常（${status}）`,
        detail: '后端进程出错或正在重启，请稍后重试；持续失败请查看后端日志。',
        status,
        raw,
      }
    }
    if (status >= 400) {
      return {
        kind: 'http',
        title: `请求被拒绝（${status}）`,
        detail: '请求未通过校验或后端拒绝处理，请检查地址与配置。',
        status,
        raw,
      }
    }
  }

  return {
    kind: 'unknown',
    title: '未知错误',
    detail: '发生未识别的错误，请查看 console 或联系管理员。',
    raw,
  }
}

/**
 * 认证状态 store：持有目标后端服务地址 + access/refresh token。
 * 本地（loopback）直连不鉴权；远端需登录后携带 token。
 * token 持久化 localStorage（refresh 自动续期需要）。
 */
export const useAuthStore = defineStore('auth', () => {
  const serverAddress = ref(localStorage.getItem(KEY_ADDR) ?? '')
  const accessToken = ref(localStorage.getItem(KEY_ACCESS) ?? '')
  const refreshToken = ref(localStorage.getItem(KEY_REFRESH) ?? '')

  /** 目标后端是否为远端（非 loopback）→ 需鉴权。 */
  const isRemote = computed(() => {
    const host = hostOf(serverAddress.value)
    return host !== '' && !isLoopbackHost(host)
  })
  const loggedIn = computed(() => !!accessToken.value)

  function persist(): void {
    localStorage.setItem(KEY_ADDR, serverAddress.value)
    localStorage.setItem(KEY_ACCESS, accessToken.value)
    localStorage.setItem(KEY_REFRESH, refreshToken.value)
  }

  function setServerAddress(addr: string): void {
    serverAddress.value = normalizeAddress(addr)
    persist()
  }

  function getBaseUrl(): string {
    return serverAddress.value
  }

  /** 远端已登录 → Authorization: Bearer；否则空。 */
  function authHeader(): Record<string, string> {
    if (isRemote.value && accessToken.value) {
      return { Authorization: `Bearer ${accessToken.value}` }
    }
    return {}
  }

  /** 登录：远端地址 → POST /api/auth/login 取双 token。 */
  async function login(addr: string, username: string, password: string): Promise<void> {
    const base = normalizeAddress(addr)
    let res: Response
    try {
      res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
    } catch (cause) {
      throw classifyError(cause)
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      const err = classifyError(new Error(body?.error ?? `HTTP ${res.status}`), res.status)
      err.backendMessage = body?.error
      throw err
    }
    const data = (await res.json()) as { accessToken: string; refreshToken: string }
    serverAddress.value = base
    accessToken.value = data.accessToken
    refreshToken.value = data.refreshToken
    persist()
  }

  /** 续期：access 过期用 refresh 换新 access。失败登出。 */
  async function refresh(): Promise<boolean> {
    if (!refreshToken.value || !serverAddress.value) return false
    let res: Response
    try {
      res = await fetch(`${serverAddress.value}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken.value }),
      })
    } catch (cause) {
      logout()
      console.warn('[auth] refresh 失败：', classifyError(cause))
      return false
    }
    if (!res.ok) {
      logout()
      return false
    }
    const data = (await res.json()) as { accessToken?: string }
    if (!data.accessToken) {
      logout()
      return false
    }
    accessToken.value = data.accessToken
    persist()
    return true
  }

  function logout(): void {
    accessToken.value = ''
    refreshToken.value = ''
    persist()
  }

  return {
    serverAddress,
    accessToken,
    refreshToken,
    isRemote,
    loggedIn,
    setServerAddress,
    getBaseUrl,
    authHeader,
    login,
    refresh,
    logout,
  }
})