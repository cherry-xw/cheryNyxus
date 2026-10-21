import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { BrowserSession } from '@chery/protocol'
import { BrowserSessionApi } from '@/services/browserSession'
import { normalizeAddress } from '@/domain/auth/serverAddress'
import { parseActiveConnection } from '@/domain/auth/activeConnection'
export { hostOf, isLoopbackHost, normalizeAddress } from '@/domain/auth/serverAddress'
export type AuthMode = 'local' | 'direct-password' | 'relay-password' | 'relay-oidc'
export interface AuthError { kind: 'network' | 'cors' | 'timeout' | 'http' | 'credential' | 'unknown'; title: string; detail: string; backendMessage?: string; status?: number; raw?: unknown }
export function classifyError(cause: unknown, status?: number): AuthError { const message = cause instanceof Error ? cause.message : String(cause); return { kind: status === 401 ? 'credential' : status ? 'http' : 'network', title: '连接未完成', detail: message, status } }
const KEY = 'chery.activeConnection.v1'
export const useAuthStore = defineStore('auth', () => {
  const serverAddress = ref(window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, ''))
  const mode = ref<AuthMode>('direct-password'); const backendId = ref(''); const username = ref('')
  const session = ref<BrowserSession | null>(null); const authenticating = ref(false); const locked = ref(true)
  const savedUsername = ref(''); const rememberPassword = ref(false); const savedPassword = ref('')
  const accessToken = computed(() => ''); const refreshToken = computed(() => ''); const relaySessionToken = computed(() => '')
  const targets = ref<Record<string, never>>({}); const isRemote = computed(() => mode.value !== 'local'); const loggedIn = computed(() => Boolean(session.value && !locked.value))
  const initial = parseActiveConnection(localStorage.getItem(KEY), window.location.origin)
  if (initial) { serverAddress.value = initial.origin + initial.basePath; backendId.value = initial.backendId }
  let generation = 0; let api = new BrowserSessionApi(serverAddress.value)
  function contextKey(): string { return JSON.stringify([generation, serverAddress.value, session.value?.revision, session.value?.identity, session.value?.target, locked.value]) }
  function summary() { return parseActiveConnection(localStorage.getItem(KEY), window.location.origin) }
  function assertCurrent(): void {
    const value = summary()
    if (!value || value.status !== 'active' || locked.value || !session.value || value.revision !== session.value.revision || value.backendId !== (session.value.target?.backendId ?? '') || value.basePath !== new URL(serverAddress.value).pathname.replace(/\/$/, '')) {
      invalidate(); throw new Error('浏览器身份或目标已改变，请等待重新确认')
    }
  }
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('chery-business-session-v1') : undefined
  function publish(status: string): void {
    localStorage.setItem(KEY, JSON.stringify({ schemaVersion: 1, revision: session.value?.revision ?? 0, status, origin: window.location.origin, basePath: new URL(serverAddress.value).pathname.replace(/\/$/, ''), backendId: backendId.value, displayIdentity: username.value, expiresAt: session.value?.expiresAt }))
    channel?.postMessage({ status, revision: session.value?.revision ?? 0 })
  }
  function apply(value: BrowserSession, broadcast = true): void { session.value = value; locked.value = false; username.value = value.identity.displayName ?? value.identity.subject; savedUsername.value = username.value; backendId.value = value.target?.backendId ?? ''; mode.value = value.mode === 'trusted-local' ? 'local' : value.mode; if (broadcast) publish('active') }
  async function restore(allowLocked = false): Promise<boolean> { const saved = summary(); if (!allowLocked && saved && saved.status !== 'active') return false; const current = generation; try { const value = await api.read(); if (allowLocked && value.identity.provider !== 'oidc') return false; const latest = summary(); if (current !== generation || (!allowLocked && latest && latest.status !== 'active') || JSON.stringify(latest) !== JSON.stringify(saved)) return false; const changed = session.value && (session.value.identity.subject !== value.identity.subject || session.value.identity.provider !== value.identity.provider || session.value.identity.issuer !== value.identity.issuer || session.value.target?.backendId !== value.target?.backendId); if (changed) { locked.value = true; generation++ } apply(value, allowLocked || !saved || saved.revision !== value.revision || saved.backendId !== (value.target?.backendId ?? '')); return true } catch { if (current === generation) { session.value = null; locked.value = true } return false } }
  function invalidate(): void { generation++; locked.value = true; session.value = null }
  async function externalChange(): Promise<void> {
    const saved = summary()
    if (saved?.status === 'active' && session.value && !locked.value && saved.revision === session.value.revision && saved.backendId === (session.value.target?.backendId ?? '') && saved.origin + saved.basePath === serverAddress.value) return
    invalidate()
    if (!saved || saved.status !== 'active') return
    serverAddress.value = saved.origin + saved.basePath; api = new BrowserSessionApi(serverAddress.value)
    await restore()
  }
  channel?.addEventListener('message', () => { void externalChange() })
  window.addEventListener('storage', (event) => { if (event.key === KEY) void externalChange() })
  window.addEventListener('focus', () => { void externalChange() })
  async function serial<T>(work: () => Promise<T>): Promise<T> { return navigator.locks ? navigator.locks.request('chery-business-session-v1', work) : work() }
  function setServerAddress(address: string): void { const next = normalizeAddress(address); if (new URL(next).origin !== window.location.origin) throw new Error('请打开目标服务的同源工作台地址后登录'); if (next !== serverAddress.value) { invalidate(); serverAddress.value = next; api = new BrowserSessionApi(next) } }
  function selectTarget(input: { address: string; backendId?: string; mode?: AuthMode }): void { setServerAddress(input.address); mode.value = input.mode ?? 'direct-password'; backendId.value = input.backendId ?? ''; locked.value = true }
  async function authenticate(work: (client: BrowserSessionApi, revision?: number) => Promise<BrowserSession>): Promise<void> {
    await serial(async () => {
      // Read the latest shared Cookie under the browser lock. A stale page must not
      // replace a newer session without the server's revision comparison.
      await externalChange()
      const client = api
      await client.discover()
      let revision: number | undefined
      try { revision = (await client.read()).revision } catch (error) {
        if ((error as { status?: number }).status !== 401) throw error
      }
      publish('switching')
      invalidate()
      const current = generation
      try {
        const value = await work(client, revision)
        if (current !== generation || client !== api) throw new Error('登录结果已被新的目标操作取代，请重新核对会话')
        apply(value)
      } catch (error) {
        if (current === generation) publish('locked')
        throw error
      }
    })
  }
  async function loginLocal(): Promise<void> { await authenticate((client) => client.local()) }
  async function login(addr: string, user: string, password: string, _remember = false): Promise<void> { setServerAddress(addr); await authenticate((client, revision) => client.password(user, password, undefined, revision)) }
  async function loginRelayPassword(addr: string, user: string, password: string, id = '', _remember = false): Promise<void> { if (!id) throw new Error('请选择Backend ID'); setServerAddress(addr); await authenticate((client, revision) => client.password(user, password, id, revision)) }
  async function chooseBackend(id: string): Promise<void> {
    await serial(async () => {
      if (!await restore() || !session.value) throw new Error('请先登录Pocket ID')
      const revision = session.value.revision; const client = api
      publish('switching'); locked.value = true; const current = ++generation
      try {
        const value = await client.target(id, revision)
        if (current !== generation || client !== api) throw new Error('设备切换结果已过期，请核对当前会话')
        apply(value)
      } catch (error) { if (current === generation) publish('locked'); throw error }
    })
  }
  async function refresh(): Promise<boolean> { return serial(async () => { if (!await restore() || !session.value) return false; const current = generation; const client = api; try { const value = await client.refresh(session.value.revision); if (current !== generation || client !== api) return false; apply(value); return true } catch { if (current === generation) invalidate(); return false } }) }
  async function logout(): Promise<void> { const previous = session.value; const client = api; locked.value = true; publish('signed-out'); const current = ++generation; try { if (previous) await serial(() => client.logout(previous.revision)); if (current !== generation) return; session.value = null; username.value = ''; publish('signed-out') } catch { if (current === generation) { session.value = null; publish('locked') }; throw new Error('本浏览器已锁定，服务端退出尚未确认') } }
  async function ticket(): Promise<{ ticket: string; wsPath: string }> { if (!await restore() || !session.value?.target) throw new Error('SESSION_EXPIRED'); assertCurrent(); return api.ticket(session.value.revision) }
  function getBaseUrl(): string { return session.value?.target ? `${session.value.target.origin}${session.value.target.httpBasePath}` : serverAddress.value }
  function authHeader(): Record<string, string> { return session.value ? { 'X-CSRF-Token': session.value.csrfToken } : {} }
  return { contextKey, assertCurrent, serverAddress, mode, backendId, username, session, authenticating, locked, accessToken, refreshToken, relaySessionToken, targets, savedUsername, rememberPassword, savedPassword, isRemote, loggedIn, restore, ticket, chooseBackend, discover: () => api.discover(), listBackends: () => api.list(), setServerAddress, selectTarget, clearSession: invalidate, reloadFromStorage: externalChange, getBaseUrl, authHeader, login, loginLocal, loginRelayPassword, savedPasswordPlain: async () => '', beginAuthentication: () => { authenticating.value = true }, finishAuthentication: () => { authenticating.value = false }, failAuthentication: () => { authenticating.value = false }, refresh, logout }
})
