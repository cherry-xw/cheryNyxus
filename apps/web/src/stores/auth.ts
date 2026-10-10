import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { randomHex, xorDecrypt, xorEncrypt } from '@/utils/obfuscate'
import { hostOf, isLoopbackHost, normalizeAddress } from '@/domain/auth/serverAddress'

export { hostOf, isLoopbackHost, normalizeAddress } from '@/domain/auth/serverAddress'

const KEY_ADDR = 'chery.serverAddress'
const KEY_ACCESS = 'chery.accessToken'
const KEY_REFRESH = 'chery.refreshToken'
const KEY_USER = 'chery.username'
const KEY_REMEMBER_PW = 'chery.rememberPassword'
const KEY_SAVED_USER = 'chery.savedUsername'
const KEY_SAVED_PW = 'chery.savedPassword'
const KEY_PW_KEY = 'chery.pwKey'
const KEY_TARGETS = 'chery.auth.targets.v1'

export type AuthMode = 'local' | 'relay-password' | 'relay-oidc'

export interface AuthTarget {
  backendId: string
  address: string
  mode: AuthMode
  username: string
  accessToken: string
  refreshToken: string
  /** Token returned by a relay OIDC adapter, when the relay uses a separate session token. */
  relaySessionToken?: string
}

export interface RelayOidcLoginInput {
  address: string
  backendId: string
  /** The adapter owns the actual OIDC redirect and relay API contract. */
  openLogin: () => Promise<{
    username?: string
    accessToken: string
    refreshToken?: string
    relaySessionToken?: string
  }>
}

export interface RelayOidcAdapter {
  login(input: RelayOidcLoginInput): Promise<{
    username?: string
    accessToken: string
    refreshToken?: string
    relaySessionToken?: string
  }>
}

let relayOidcAdapter: RelayOidcAdapter | null = null

/** Install the relay OIDC adapter without coupling the preload shell to relay endpoints. */
export function configureRelayOidc(adapter: RelayOidcAdapter | null): void {
  relayOidcAdapter = adapter
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

interface LoginChallenge {
  challengeId: string
  nonce: string
}

/** 向后端申请一次性登录挑战（challenge）。失败抛 classifyError 归类结果。 */
async function fetchChallenge(base: string, username: string): Promise<LoginChallenge> {
  let res: Response
  try {
    res = await fetch(`${base}/api/auth/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
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
  return (await res.json()) as LoginChallenge
}

/**
 * 用 challenge nonce 作为 keyHex，SHA-256 CTR 流密码加密 `{username, password}` 信封。
 * 纯 JS（无 WebCrypto），非安全上下文（非 HTTPS 远端）亦可用。
 * 返回可直接 POST /api/auth/login 的载荷。
 */
function encryptCredentials(
  challengeId: string,
  nonce: string,
  username: string,
  password: string,
): { challengeId: string; cipher: string } {
  return { challengeId, cipher: xorEncrypt(nonce, JSON.stringify({ username, password })) }
}

/**
 * 取本地「记住密码」keyHex：localStorage 无则生成随机 hex（32B）持久化。
 * key 存 localStorage（客户端可恢复）→ 静态混淆级，防明文裸露，不防运行时提取。
 */
async function getPwKeyHex(): Promise<string> {
  const stored = localStorage.getItem(KEY_PW_KEY)
  if (stored) return stored
  const key = randomHex(32)
  localStorage.setItem(KEY_PW_KEY, key)
  return key
}

/** 加密密码 → base64 密文（SHA-256 CTR，无 WebCrypto）。 */
async function encryptPasswordForStorage(password: string): Promise<string> {
  return xorEncrypt(await getPwKeyHex(), password)
}

/** 解密 base64 密文 → 明文密码；失败返回 null。 */
async function decryptPasswordFromStorage(data: string): Promise<string | null> {
  try {
    return xorDecrypt(await getPwKeyHex(), data)
  } catch {
    return null
  }
}

/**
 * 认证状态 store：持有目标后端服务地址 + access/refresh token。
 * 本地（loopback）直连不鉴权；远端需登录后携带 token。
 * token 持久化 localStorage（refresh 自动续期需要）。
 */
export const useAuthStore = defineStore('auth', () => {
  const storedAddress = localStorage.getItem(KEY_ADDR) ?? ''
  const storedAccessToken = localStorage.getItem(KEY_ACCESS) ?? ''
  const serverAddress = ref(storedAddress)
  const mode = ref<AuthMode>(
    (localStorage.getItem('chery.auth.mode') as AuthMode | null) ??
      (storedAccessToken && !isLoopbackHost(hostOf(storedAddress)) ? 'relay-password' : 'local'),
  )
  const backendId = ref(localStorage.getItem('chery.auth.backendId') ?? '')
  const accessToken = ref(storedAccessToken)
  const refreshToken = ref(localStorage.getItem(KEY_REFRESH) ?? '')
  const relaySessionToken = ref('')
  const username = ref(localStorage.getItem(KEY_USER) ?? '')
  /** 记住密码：默认关；勾选后密码 AES-GCM 加密存 localStorage，下次预填。 */
  const rememberPassword = ref(localStorage.getItem(KEY_REMEMBER_PW) === '1')
  /** 已记住的用户名（服务地址+用户名始终默认记住）。 */
  const savedUsername = ref(localStorage.getItem(KEY_SAVED_USER) ?? '')
  /** 已记住的密码密文（base64(iv||ct)）；未勾选记住密码时为空。 */
  const savedPassword = ref(localStorage.getItem(KEY_SAVED_PW) ?? '')
  const authenticating = ref(false)
  const targets = ref<Record<string, AuthTarget>>(readTargets())

  /** 目标后端是否为远端（非 loopback）→ 需鉴权。 */
  const isRemote = computed(() => {
    if (mode.value !== 'local') return true
    const host = hostOf(serverAddress.value)
    return host !== '' && !isLoopbackHost(host)
  })
  const loggedIn = computed(() => mode.value === 'local' || !!accessToken.value)

  function targetKey(id: string, address: string): string {
    return `${id || '_address'}:${normalizeAddress(address)}`
  }

  function readTargets(): Record<string, AuthTarget> {
    try {
      const raw = localStorage.getItem(KEY_TARGETS)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as Record<string, AuthTarget>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function persistTargets(): void {
    localStorage.setItem(KEY_TARGETS, JSON.stringify(targets.value))
  }

  function persistCurrentTarget(): void {
    if (!serverAddress.value) return
    targets.value[targetKey(backendId.value, serverAddress.value)] = {
      backendId: backendId.value,
      address: serverAddress.value,
      mode: mode.value,
      username: username.value,
      accessToken: accessToken.value,
      refreshToken: refreshToken.value,
      relaySessionToken: relaySessionToken.value || undefined,
    }
    persistTargets()
  }

  function persist(): void {
    localStorage.setItem(KEY_ADDR, serverAddress.value)
    localStorage.setItem('chery.auth.mode', mode.value)
    localStorage.setItem('chery.auth.backendId', backendId.value)
    localStorage.setItem(KEY_ACCESS, accessToken.value)
    localStorage.setItem(KEY_REFRESH, refreshToken.value)
    localStorage.setItem(KEY_USER, username.value)
    localStorage.setItem(KEY_REMEMBER_PW, rememberPassword.value ? '1' : '0')
    localStorage.setItem(KEY_SAVED_USER, savedUsername.value)
    localStorage.setItem(KEY_SAVED_PW, savedPassword.value)
  }

  function setServerAddress(addr: string): void {
    serverAddress.value = normalizeAddress(addr)
    persist()
  }

  /** Select a backend and restore only that backend's session, if one exists. */
  function selectTarget(input: { address: string; backendId?: string; mode?: AuthMode }): void {
    const nextAddress = normalizeAddress(input.address)
    const nextId = input.backendId ?? ''
    const nextMode = input.mode ?? (isLoopbackHost(hostOf(nextAddress)) ? 'local' : 'relay-password')
    const saved = targets.value[targetKey(nextId, nextAddress)]
    if (mode.value !== 'local' && serverAddress.value && (nextAddress !== serverAddress.value || nextId !== backendId.value)) {
      const relayBase = serverAddress.value.replace(/\/backend\/[^/]+\/?$/, '')
      void fetch(`${relayBase}/api/session/backend`, { method: 'DELETE', credentials: 'include' }).catch(() => undefined)
    }
    serverAddress.value = nextAddress
    backendId.value = nextId
    mode.value = nextMode
    username.value = saved?.username ?? ''
    accessToken.value = saved?.accessToken ?? ''
    refreshToken.value = saved?.refreshToken ?? ''
    relaySessionToken.value = saved?.relaySessionToken ?? ''
    persist()
  }

  function clearSession(): void {
    accessToken.value = ''
    refreshToken.value = ''
    relaySessionToken.value = ''
    username.value = ''
    persistCurrentTarget()
    persist()
  }

  function beginAuthentication(): void {
    authenticating.value = true
  }

  function finishAuthentication(): void {
    authenticating.value = false
  }

  function failAuthentication(): void {
    authenticating.value = false
  }

  /** 另一浏览器窗口更新 localStorage 后显式刷新本 Pinia 状态。 */
  function reloadFromStorage(): void {
    serverAddress.value = localStorage.getItem(KEY_ADDR) ?? ''
    mode.value = (localStorage.getItem('chery.auth.mode') as AuthMode | null) ?? 'local'
    backendId.value = localStorage.getItem('chery.auth.backendId') ?? ''
    accessToken.value = localStorage.getItem(KEY_ACCESS) ?? ''
    refreshToken.value = localStorage.getItem(KEY_REFRESH) ?? ''
    relaySessionToken.value = ''
    username.value = localStorage.getItem(KEY_USER) ?? ''
    rememberPassword.value = localStorage.getItem(KEY_REMEMBER_PW) === '1'
    savedUsername.value = localStorage.getItem(KEY_SAVED_USER) ?? ''
    savedPassword.value = localStorage.getItem(KEY_SAVED_PW) ?? ''
    targets.value = readTargets()
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

  /** 登录：远端地址 → 取 challenge → 加密凭据 → POST /api/auth/login 取双 token。 */
  async function login(
    addr: string,
    user: string,
    password: string,
    rememberPw = false,
  ): Promise<void> {
    const base = normalizeAddress(addr)
    let res: Response
    try {
      const challenge = await fetchChallenge(base, user)
      const sealed = await encryptCredentials(
        challenge.challengeId,
        challenge.nonce,
        user,
        password,
      )
      res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sealed),
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
    const data = (await res.json()) as {
      username?: string
      accessToken: string
      refreshToken: string
    }
    mode.value = 'relay-password'
    serverAddress.value = base
    // The optional Backend ID is supplied by the relay target picker.
    username.value = data.username ?? ''
    accessToken.value = data.accessToken
    refreshToken.value = data.refreshToken
    // 服务地址 + 用户名始终默认记住；密码仅勾选「记住密码」时才加密存储。
    savedUsername.value = data.username ?? user
    rememberPassword.value = rememberPw
    savedPassword.value = rememberPw ? await encryptPasswordForStorage(password) : ''
    persist()
    persistCurrentTarget()
  }

  async function loginRelayPassword(
    addr: string,
    user: string,
    password: string,
    selectedBackendId = '',
    rememberPw = false,
  ): Promise<void> {
    if (!selectedBackendId) throw new Error('请选择要连接的 Backend ID')
    const relay = normalizeAddress(addr)
    const bindResponse = await fetch(`${relay}/api/session/backend`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backendId: selectedBackendId }),
    })
    if (!bindResponse.ok) {
      const body = (await bindResponse.json().catch(() => null)) as { error?: { message?: string } } | null
      throw classifyError(new Error(body?.error?.message ?? `HTTP ${bindResponse.status}`), bindResponse.status)
    }
    backendId.value = selectedBackendId
    await login(`${relay}/backend/${selectedBackendId}`, user, password, rememberPw)
  }

  /**
   * Start the relay OIDC flow through an injected adapter. The web layer does not
   * know relay routes, callback URLs, or Pocket ID details.
   */
  async function loginRelayOidc(input: RelayOidcLoginInput): Promise<void> {
    if (!relayOidcAdapter) throw new Error('中转 OIDC 尚未配置')
    const base = normalizeAddress(input.address)
    const data = await relayOidcAdapter.login({ ...input, address: base })
    mode.value = 'relay-oidc'
    serverAddress.value = base
    backendId.value = input.backendId
    username.value = data.username ?? ''
    accessToken.value = data.accessToken
    refreshToken.value = data.refreshToken ?? ''
    relaySessionToken.value = data.relaySessionToken ?? ''
    persist()
    targets.value[targetKey(input.backendId, base)] = {
      backendId: input.backendId,
      address: base,
      mode: 'relay-oidc',
      username: username.value,
      accessToken: accessToken.value,
      refreshToken: refreshToken.value,
      relaySessionToken: data.relaySessionToken,
    }
    persistTargets()
  }

  /** 预填用：若勾选「记住密码」则解密返回明文密码，否则空串。失败（key/密文损坏）返回空串。 */
  async function savedPasswordPlain(): Promise<string> {
    if (!rememberPassword.value || !savedPassword.value) return ''
    return (await decryptPasswordFromStorage(savedPassword.value)) ?? ''
  }

  /** 续期：access 过期用 refresh 换新 access。失败登出。 */
  async function refresh(): Promise<boolean> {
    if (!refreshToken.value || !serverAddress.value) return false
    let res: Response
    try {
      res = await fetch(`${serverAddress.value}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
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
    persistCurrentTarget()
    return true
  }

  function logout(): void {
    if (mode.value !== 'local' && serverAddress.value) {
      const relayBase = serverAddress.value.replace(/\/backend\/[^/]+\/?$/, '')
      void fetch(`${relayBase}/api/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined)
    }
    authenticating.value = false
    accessToken.value = ''
    refreshToken.value = ''
    relaySessionToken.value = ''
    username.value = ''
    // 服务地址 + 用户名始终保留（下次预填）；记住密码时保留密文，否则清空。
    if (!rememberPassword.value) savedPassword.value = ''
    persistCurrentTarget()
    persist()
  }

  return {
    serverAddress,
    mode,
    backendId,
    targets,
    accessToken,
    refreshToken,
    relaySessionToken,
    username,
    rememberPassword,
    savedUsername,
    savedPassword,
    isRemote,
    loggedIn,
    setServerAddress,
    selectTarget,
    clearSession,
    reloadFromStorage,
    getBaseUrl,
    authHeader,
    login,
    loginRelayPassword,
    loginRelayOidc,
    savedPasswordPlain,
    authenticating,
    beginAuthentication,
    finishAuthentication,
    failAuthentication,
    refresh,
    logout,
  }
})
