import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAuthStore } from '../../src/stores/auth'
import { BrowserSessionApi } from '../../src/services/browserSession'
const origin = 'http://10.2.3.6:8183'
const storage = new Map<string, string>()
vi.stubGlobal('window', { location: { origin }, addEventListener: () => {} })
vi.stubGlobal('navigator', {})
vi.stubGlobal('BroadcastChannel', undefined)
vi.stubGlobal('localStorage', { clear: () => storage.clear(), getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
const key = 'chery.activeConnection.v1'
const session = { protocolVersion: 1 as const, authenticated: true as const, revision: 1, mode: 'direct-password' as const, identity: { subject: 'user', provider: 'password' as const }, target: { origin, basePath: '', httpBasePath: '', wsPath: '/ws' }, expiresAt: new Date(Date.now() + 60000).toISOString(), csrfToken: 'c'.repeat(32) }
describe('whole-browser identity transitions without UI automation', () => {
  beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()); vi.restoreAllMocks() })
  it('never restores old server identity while switching or signed-out', async () => {
    const read = vi.spyOn(BrowserSessionApi.prototype, 'read').mockResolvedValue(session)
    const auth = useAuthStore(); expect(await auth.restore()).toBe(true)
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, revision: 1, status: 'switching', origin, basePath: '', backendId: '', displayIdentity: 'user' }))
    await auth.reloadFromStorage()
    expect(auth.locked).toBe(true); expect(auth.session).toBeNull(); expect(read).toHaveBeenCalledTimes(1)
    expect(() => auth.assertCurrent()).toThrow()
  })
  it('isolates delayed restore when another page changes storage', async () => {
    let finish!: (value: typeof session) => void
    vi.spyOn(BrowserSessionApi.prototype, 'read').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const auth = useAuthStore(); const pending = auth.restore()
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, revision: 1, status: 'signed-out', origin, basePath: '', backendId: '', displayIdentity: '' }))
    finish(session)
    expect(await pending).toBe(false); expect(auth.locked).toBe(true); expect(auth.session).toBeNull()
  })
  it('does not apply a late password login after another page locks the browser', async () => {
    vi.spyOn(BrowserSessionApi.prototype, 'discover').mockResolvedValue({ password: true, oidc: false, service: 'backend', csrfToken: 'c'.repeat(32) })
    vi.spyOn(BrowserSessionApi.prototype, 'read').mockRejectedValue(Object.assign(new Error('SESSION_EXPIRED'), { status: 401 }))
    let finish!: (value: typeof session) => void
    vi.spyOn(BrowserSessionApi.prototype, 'password').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const auth = useAuthStore(); const pending = auth.login(origin, 'user', 'synthetic-password')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, revision: 1, status: 'signed-out', origin, basePath: '', backendId: '', displayIdentity: '' }))
    await auth.reloadFromStorage(); finish(session)
    await expect(pending).rejects.toThrow('取代')
    expect(auth.loggedIn).toBe(false); expect(auth.session).toBeNull()
  })
  it('same-target revision renewal preserves live cache ownership', async () => {
    const read = vi.spyOn(BrowserSessionApi.prototype, 'read').mockResolvedValue(session)
    const auth = useAuthStore(); await auth.restore()
    read.mockResolvedValue({ ...session, revision: 2 })
    expect(await auth.restore()).toBe(true)
    expect(auth.locked).toBe(false); expect(auth.session?.revision).toBe(2)
    expect(() => auth.assertCurrent()).not.toThrow()
  })
  it('explicit OIDC return verifies server identity before replacing a signed-out summary', async () => {
    const read = vi.spyOn(BrowserSessionApi.prototype, 'read').mockResolvedValue(session)
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, revision: 1, status: 'signed-out', origin, basePath: '', backendId: '', displayIdentity: '' }))
    const auth = useAuthStore(); expect(await auth.restore()).toBe(false)
    expect(await auth.restore(true)).toBe(false)
    read.mockResolvedValue({ ...session, mode: 'relay-oidc', identity: { subject: 'pocket-user', provider: 'oidc' }, target: null } as any)
    expect(await auth.restore(true)).toBe(true)
    expect(auth.session?.target).toBeNull(); expect(auth.session?.identity.provider).toBe('oidc')
    expect(JSON.parse(localStorage.getItem(key)!).status).toBe('active')
  })
})
