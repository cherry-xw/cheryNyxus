import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accountStore.js'
import { createManager, readBackendNetworkFromConfig, readManagerHostFromConfig } from '../src/server.js'
import { runManagerCli } from '../src/cli.js'

const roots: string[] = []
const managers: ReturnType<typeof createManager>[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
async function fixture(extra: Parameters<typeof createManager>[0] = {}, configured = true) {
  const root = await mkdtemp(join(tmpdir(), 'manager-auth-')); roots.push(root)
  const authFile = join(root, 'auth.json')
  const account = new AccountStore(authFile)
  if (configured) await account.save('owner', 'manager-test-password')
  const configFile = join(root, 'config.yaml')
  await writeFile(configFile, 'server:\n  port: 1\n  webPort: 1\n')
  const manager = createManager({ port: 0, authFile, configFile, credentialsFile: join(root, 'credentials.json'),
    controlToken: 'machine-test-key', backendCommand: process.execPath, backendArgs: ['-e', `process.on('message', m => { if (m.type === 'stop-force' || m.type === 'stop-drain') process.exit(0) }); setInterval(()=>{},1000)`], ...extra })
  managers.push(manager); await manager.listen()
  const base = `http://127.0.0.1:${manager.address()!.port}`
  const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init)
  const login = () => request('/api/auth/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }) })
  return { root, account, authFile, manager, base, request, login }
}
function session(response: Response) { return response.headers.get('set-cookie')!.split(';')[0]! }

describe('Manager authentication HTTP', () => {
  it('changes the account password and revokes all previous sessions', async () => {
    const f = await fixture()
    const Cookie = session(await f.login())
    const headers = { Cookie, Origin: f.base, 'Content-Type': 'application/json' }
    const changed = await f.request('/api/auth/password', { method: 'POST', headers, body: JSON.stringify({ currentPassword: 'manager-test-password', newPassword: 'new-manager-test-password' }) })
    expect(changed.status).toBe(200)
    expect((await f.request('/api/status', { headers })).status).toBe(401)
    expect((await f.login()).status).toBe(401)
    const fresh = await f.request('/api/auth/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'new-manager-test-password' }) })
    expect(fresh.status).toBe(200)
  })
  it('fails closed before local setup and never remotely initializes', async () => {
    const f = await fixture({}, false)
    expect(await (await f.request('/api/auth/capabilities')).json()).toEqual({ password: false, oidc: false, allowInitialSetup: true, initialized: false })
    expect((await f.login()).status).toBe(503)
    expect((await f.request('/api/auth/setup', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }) })).status).toBe(200)
    expect(await (await f.request('/api/auth/capabilities')).json()).toEqual({ password: true, oidc: false, allowInitialSetup: false, initialized: true })
    expect((await f.request('/api/auth/setup', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other', password: 'manager-test-password' }) })).status).toBe(409)
    await expect(runManagerCli(['auth', 'setup', '--password', 'do-not-log'])).rejects.toThrow('禁止密码参数')
    await expect(runManagerCli(['auth', 'setup'])).rejects.toThrow('交互终端')
  })
  it('stores salted scrypt only, limits permissions, and refuses accidental replacement', async () => {
    const f = await fixture()
    const text = await readFile(f.authFile, 'utf8')
    expect(text).not.toContain('manager-test-password')
    expect(JSON.parse(text)).toMatchObject({ version: 1, username: 'owner' })
    if (process.platform !== 'win32') expect((await stat(f.authFile)).mode & 0o777).toBe(0o600)
    await expect(f.account.save('owner', 'other-test-password')).rejects.toThrow('已存在')
    await expect(f.account.save('owner', 'short', true)).rejects.toThrow('12')
  })

  it('rejects invalid setup without closing the gate', async () => {
    const f = await fixture({}, false)
    expect((await f.request('/api/auth/setup', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'short' }) })).status).toBe(400)
    expect(await (await f.request('/api/auth/capabilities')).json()).toMatchObject({ allowInitialSetup: true, initialized: false })
    expect((await f.request('/api/auth/setup', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }) })).status).toBe(403)
  })
  it('rejects every old user token and all loopback exemptions', async () => {
    const f = await fixture()
    for (const headers of [{}, { 'X-Chery-Manager-Token': 'machine-test-key' }, { Cookie: 'chery-manager-token=machine-test-key' }, { Authorization: 'Bearer machine-test-key' }] as Record<string, string>[]) {
      expect((await f.request('/api/status?token=machine-test-key', { headers })).status).toBe(401)
      expect((await f.request('/api/credentials', { headers })).status).toBe(401)
    }
    expect((await f.request('/', { headers: { 'X-Chery-Manager-Machine-Key': 'machine-test-key' } })).status).toBe(401)
  })
  it('issues private opaque session, preserves offline management, and invalidates logout replay', async () => {
    const f = await fixture()
    const login = await f.login(); expect(await login.json()).toEqual({ authenticated: true })
    expect(login.headers.get('set-cookie')).toContain('HttpOnly')
    expect(login.headers.get('set-cookie')).toContain('SameSite=Lax')
    expect(login.headers.get('x-chery-manager-token')).toBeNull()
    const Cookie = session(login), headers = { Cookie, Origin: f.base, 'Content-Type': 'application/json' }
    expect(await (await f.request('/api/auth/me', { headers })).json()).toMatchObject({ authenticated: true, username: 'owner', provider: 'password' })
    expect(await (await f.request('/api/status', { headers })).json()).toMatchObject({ backend: { status: 'unknown' }, backendPlugin: { running: false }, maintenance: { status: 'not_checked' } })
    for (const action of ['start', 'restart', 'stop']) expect((await f.request(`/api/backend/${action}`, { method: 'POST', headers })).status).toBe(200)
    const rotated = await f.request('/api/credentials/rotate', { method: 'POST', headers, body: JSON.stringify({ username: 'backend-owner', password: 'backend-test-password' }) })
    const rotatedBody = await rotated.json()
    expect(rotated.status).toBe(409)
    expect(rotatedBody).toMatchObject({ error: { code: 'machine_credentials_deployment_required' } })
    const credentialBody = await (await f.request('/api/credentials', { headers })).json()
    expect(credentialBody).toMatchObject({ username: '', consistent: false, source: 'missing' })
    expect(credentialBody).not.toHaveProperty('password')
    const saved = await f.request('/api/relay/config', { method: 'PUT', headers, body: JSON.stringify({ url: 'https://relay.example', backendId: 'test-home', publicDiscovery: false, remotePasswordEnabled: false }) })
    expect(saved.status).toBe(200)
    expect(await (await f.request('/api/relay/config', { headers })).json()).toMatchObject({ backendId: 'test-home' })
    expect((await f.request('/api/auth/logout', { method: 'POST', headers })).status).toBe(200)
    expect((await f.request('/api/auth/me', { headers })).status).toBe(401)
  })
  it('invalidates expiry, account recovery and manager restart', async () => {
    let now = Date.now()
    const f = await fixture({ now: () => now, auth: { sessionTtlMs: 1000 } })
    let Cookie = session(await f.login())
    now += 1001
    expect((await f.request('/api/auth/me', { headers: { Cookie } })).status).toBe(401)
    Cookie = session(await f.login())
    await f.account.save('owner', 'replacement-password', true)
    expect((await f.request('/api/auth/me', { headers: { Cookie } })).status).toBe(401)
    expect((await f.login()).status).toBe(401)
    const other = createManager({ port: 0, authFile: f.authFile, controlToken: 'machine-test-key' })
    managers.push(other); await other.listen()
    expect((await fetch(`http://127.0.0.1:${other.address()!.port}/api/auth/me`, { headers: { Cookie } })).status).toBe(401)
  })
  it('rejects missing/cross Origin, bad Host, untrusted forwarding and malformed bodies', async () => {
    const f = await fixture()
    for (const Origin of [undefined, 'https://evil.example', 'null']) {
      expect((await f.request('/api/auth/login', { method: 'POST', headers: Origin ? { Origin } : {} })).status).toBe(403)
    }
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${f.base}/api/auth/capabilities`, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume(); resolve(response.statusCode!)
      })
      request.on('error', reject); request.end()
    })
    expect(badHostStatus).toBe(403)
    expect((await f.request('/api/auth/capabilities', { headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } })).status).toBe(403)
    const Cookie = session(await f.login())
    expect((await f.request('/api/backend/start', { method: 'POST', headers: { Cookie, Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await f.request('/api/auth/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400)
    expect((await f.request('/api/auth/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(18000) }) })).status).toBe(400)
  })
  it('sets Secure only through explicitly trusted HTTPS proxy and checks origin', async () => {
    const f = await fixture({ auth: { trustedOrigins: ['https://manager.example'], trustedProxies: ['127.0.0.1'] } })
    const headers = { 'X-Forwarded-Host': 'manager.example', 'X-Forwarded-Proto': 'https', Origin: 'https://manager.example', 'Content-Type': 'application/json' }
    const response = await f.request('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }) })
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('; Secure')
  })
  it('isolates machine permissions and rejects browser-bearing machine requests', async () => {
    const f = await fixture(), key = { 'X-Chery-Manager-Machine-Key': 'machine-test-key' }
    expect((await f.request('/api/machine/connection', { headers: key })).status).toBe(200)
    expect((await f.request('/api/machine/status', { headers: key })).status).toBe(200)
    for (const extra of [{ Origin: f.base }, { Cookie: 'anything=x' }, { 'Sec-Fetch-Site': 'same-origin' }, { 'X-Forwarded-Proto': 'http' }] as Record<string, string>[]) {
      expect((await f.request('/api/machine/status', { headers: { ...key, ...extra } })).status).not.toBe(200)
    }
    for (const path of ['/api/status', '/api/credentials', '/api/credentials/rotate', '/']) expect((await f.request(path, { headers: key })).status).toBe(401)
    expect((await f.request('/api/machine/credentials', { headers: key })).status).toBe(404)
    for (const action of ['start', 'restart', 'stop']) expect((await f.request(`/api/machine/backend/${action}`, { method: 'POST', headers: key })).status).toBe(200)
  })
  it('limits failed password attempts', async () => {
    const f = await fixture()
    for (let i = 0; i < 10; i++) expect((await f.request('/api/auth/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong-password' }) })).status).toBe(401)
    expect((await f.login()).status).toBe(429)
  })
  it('reads listener settings without backend dependency', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'settings.yaml'), 'manager:\n  host: 0.0.0.0\nserver:\n  port: 9991\n  webPort: 9992\n')
    expect(await readManagerHostFromConfig(join(f.root, 'settings.yaml'))).toBe('0.0.0.0')
    expect(await readBackendNetworkFromConfig(join(f.root, 'settings.yaml'))).toMatchObject({ wsPort: 9991, webPort: 9992 })
  })

  it('does not create QQ credentials or serve legacy QQ endpoints', async () => {
    const f = await fixture()
    const Cookie = session(await f.login())
    const headers = { Cookie, Origin: f.base }
    expect((await f.request('/api/qq/connection-token', { headers })).status).toBe(404)
    expect((await f.request('/api/qq/connection-token/rotate', { method: 'POST', headers })).status).toBe(404)
    expect((await f.request('/api/connections/qq/credential', { headers })).status).toBe(404)
  })
})
