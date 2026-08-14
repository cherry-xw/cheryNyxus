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
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `登录失败 (${res.status})`)
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
    try {
      const res = await fetch(`${serverAddress.value}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken.value }),
      })
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
    } catch {
      logout()
      return false
    }
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