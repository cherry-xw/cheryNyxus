import { createServer, type RequestListener } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManager } from '../src/server.js'
import { AccountStore } from '../src/accountStore.js'
import { CredentialStore } from '../src/credentials.js'
import { RelayClientConfigStore } from '../src/relayClientConfig.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp('/home/chery/.hermes/cache/scratch/login-development/manager-completion-')
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const configFile = join(root, 'config.yaml'), authFile = join(root, 'auth.json'), credentialsFile = join(root, 'credentials.json')
  await writeFile(configFile, yaml.dump({ server: { host: '10.2.3.6', port: 1, webPort: 1 }, relay: { url: '', backendId: '', publicDiscovery: false, remotePasswordEnabled: true } }))
  await new AccountStore(authFile).save('owner', 'synthetic-manager-password')
  const manager = createManager({ host: '0.0.0.0', port: 0, backendMode: 'external', configFile, authFile, credentialsFile, tokenFile: join(root, 'token.json'), auth: { trustedOrigins: ['https://manager.example'], trustedProxies: ['10.2.3.6', '::ffff:10.2.3.6'] }, ...extra })
  await manager.listen(); cleanup.push(() => manager.close())
  const base = `http://10.2.3.6:${manager.address()!.port}`
  let Cookie = ''
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { 'X-Forwarded-Host': 'manager.example', 'X-Forwarded-Proto': 'https', ...(Cookie ? { Cookie } : {}), ...(method !== 'GET' ? { Origin: 'https://manager.example', 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const login = await request('/api/auth/login', 'POST', { username: 'owner', password: 'synthetic-manager-password' }); expect(login.status).toBe(200); Cookie = login.headers.get('set-cookie')!.split(';')[0]!
  return { request, manager, root, configFile, credentialsFile }
}
async function listen(handler: RequestListener) {
  const server = createServer(handler); await new Promise<void>((r) => server.listen(0, '0.0.0.0', r)); cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
  return `http://10.2.3.6:${(server.address() as { port: number }).port}`
}
describe('F02 Manager relay secret and retired route boundaries', () => {
  it('never sends injected global keys, cookies or machine keys to editable health URL', async () => {
    vi.stubEnv('CHERY_RELAY_ADMIN_TOKEN', 'synthetic-global-secret'); vi.stubEnv('RELAY_ADMIN_SECRET', 'synthetic-second-global-secret')
    const seen: unknown[] = []
    const destination = await listen((req, res) => { seen.push({ path: req.url, headers: req.headers }); res.end('ok') })
    const f = await fixture()
    expect((await f.request('/api/relay/config', 'PUT', { url: destination, backendId: 'test-device', publicDiscovery: false, remotePasswordEnabled: true })).status).toBe(200)
    const status = await f.request('/api/relay/status'); expect(status.status).toBe(200)
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ path: '/healthz' })
    const serialized = JSON.stringify(seen)
    for (const secret of ['synthetic-global-secret', 'synthetic-second-global-secret', 'chery-manager-session', 'authorization', 'x-chery-manager-machine-key']) expect(serialized).not.toContain(secret)
    expect(await status.json()).toMatchObject({ status: 'reachable-not-verified' })
  })
  it('does not follow health redirects to another destination', async () => {
    let hits = 0
    const target = await listen((_req, res) => { hits++; res.end('forbidden destination') })
    const source = await listen((_req, res) => { res.writeHead(302, { Location: target + '/capture' }); res.end() })
    const f = await fixture()
    await f.request('/api/relay/config', 'PUT', { url: source, backendId: 'test-device', publicDiscovery: false, remotePasswordEnabled: true })
    expect(await (await f.request('/api/relay/status')).json()).toMatchObject({ status: 'not_connected' }); expect(hits).toBe(0)
  })
  it('old global binding routes return 410 without external requests', async () => {
    const f = await fixture()
    for (const [path, method] of [['/api/relay/bindings', 'GET'], ['/api/relay/bindings/revoke', 'POST']]) {
      const response = await f.request(path!, method!, method === 'GET' ? undefined : {}); expect(response.status).toBe(410); expect(await response.json()).toEqual({ error: 'relay_global_management_retired' })
    }
  })
})
describe('F09 Manager external owner and desired/applied state', () => {
  it('rejects every rathole and external Backend control without spawn', async () => {
    const f = await fixture({ ratholeCommand: '/must-not-spawn', backendCommand: '/must-not-spawn' })
    for (const owner of ['rathole', 'backend']) for (const action of ['start', 'stop', 'restart']) expect((await f.request(`/api/${owner}/${action}`, 'POST', {})).status).toBe(409)
    expect(f.manager.controller.isManaged('rathole')).toBe(false); expect(f.manager.controller.isManaged('backend')).toBe(false)
  })
  it('classifies fresh, stale, foreign ID, un-applied and malformed state; save never restarts', async () => {
    const root = '/home/chery/.hermes/cache/scratch/login-development/status-' + randomBytes(12).toString('hex')
    const statusFile = root + '/status.json', clientFile = root + '/client.json'
    const store = new RelayClientConfigStore(clientFile)
    const input = { protocolVersion: 1, url: 'wss://relay.example/control/backend', backendId: 'test-device', displayName: 'Test', keyFile: root + '/key.json', authorizationFile: root + '/auth.json', ratholeConfigPath: root + '/client.toml', ratholeServerAddr: 'relay.example:2333', proofIssuer: 'https://relay.example', statusFile, encryptedTransport: '[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = "' + Buffer.alloc(32, 7).toString('base64') + '"\n' }
    const desired = await store.save(input) as { desiredRevision: string }; cleanup.push(() => rm(root, { recursive: true, force: true }))
    const f = await fixture({ relayClientConfigFile: clientFile, relayStatusFile: statusFile })
    const state = { protocolVersion: 2, instanceId: 'i'.repeat(32), backendId: 'test-device', status: 'online', configVersion: 1, desiredRevision: desired.desiredRevision, appliedRevision: desired.desiredRevision, leaseId: 'l'.repeat(32), updatedAt: new Date().toISOString() }
    for (const [change, status, reason] of [[{}, 'online', undefined], [{ updatedAt: new Date(0).toISOString() }, 'unknown', 'stale_status'], [{ backendId: 'foreign-device' }, 'unknown', 'device_identity_mismatch'], [{ desiredRevision: 'not-applied', appliedRevision: 'not-applied' }, 'unknown', 'configuration_not_applied'], [{ extra: 'secret' }, 'unknown', 'invalid_status']] as const) {
      await writeFile(statusFile, JSON.stringify({ ...state, ...change })); const view = await (await f.request('/api/status')).json() as any
      expect(view.relay.status).toBe(status); if (reason) expect(view.relay.reason).toBe(reason)
    }
    await writeFile(statusFile, JSON.stringify(state))
    expect((await f.request('/api/relay/client-config', 'PUT', { ...input, displayName: 'Changed' })).status).toBe(200)
    expect((await (await f.request('/api/status')).json() as any).relay.reason).toBe('configuration_not_applied')
    expect(f.manager.controller.isManaged('rathole')).toBe(false)
    expect((await f.request('/api/relay/device-operation', 'POST', { type: 'policy.get' })).status).toBe(503)
    expect((await f.request('/api/auth/me')).status).toBe(200)
  })
})
describe('F09/F13 strict Backend status readback', () => {
  it('does not mistake stale/old/wrong listener records or bare TCP reachability for verified running', async () => {
    const upstream = await listen((_req, res) => res.end('not-business-ready')), port = Number(new URL(upstream).port)
    const root = '/home/chery/.hermes/cache/scratch/login-development/backend-status-' + randomBytes(12).toString('hex'); await (await import('node:fs/promises')).mkdir(root, { recursive: true }); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const file = root + '/status.json', f = await fixture({ backendStatusFile: file })
    await writeFile(f.configFile, yaml.dump({ server: { host: '10.2.3.6', port, webPort: port } }))
    const valid = { protocolVersion: 1, instanceId: 'i'.repeat(32), status: 'running', addresses: { local: { httpPort: port, websocketPort: port } }, agents: { initializedChats: 0, runningChats: 0, activeRuns: 0 }, updatedAt: new Date().toISOString() }
    for (const [change, expected] of [[{}, 'running'], [{ protocolVersion: 0 }, 'reachable-not-verified'], [{ updatedAt: new Date(0).toISOString() }, 'reachable-not-verified'], [{ addresses: { local: { httpPort: 1, websocketPort: 1 } } }, 'reachable-not-verified'], [{ agents: { secret: 'reject' } }, 'reachable-not-verified']] as const) {
      await writeFile(file, JSON.stringify({ ...valid, ...change })); expect((await (await f.request('/api/status')).json() as any).backend.status).toBe(expected)
    }
  })
})
describe('F13 maintenance discovery failure stays local', () => {
  it.each(['missing', 'shape', 'permission', 'capability'])('keeps Manager identity with %s maintenance', async (failure) => {
    const upstream = await listen((req, res) => {
      req.resume(); res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/machine/login') { res.end(JSON.stringify({ accessToken: 'synthetic-machine-access' })); return }
      if (failure === 'missing') { res.writeHead(404).end('{}'); return }
      if (failure === 'permission') { res.writeHead(403).end('{}'); return }
      res.end(JSON.stringify(failure === 'shape' ? { protocolVersion: 1, secret: 'not-accepted' } : { protocolVersion: 1, instanceId: 'instance', protocolRange: { min: 1, max: 1 }, operations: [], listener: 'local' }))
    })
    const f = await fixture(); await new CredentialStore({ configFile: f.configFile, credentialsFile: f.credentialsFile }).rotate({ username: 'machine', password: 'synthetic-machine-password' })
    const raw = yaml.load(await (await import('node:fs/promises')).readFile(f.configFile, 'utf8')) as any; raw.server.webPort = Number(new URL(upstream).port); await writeFile(f.configFile, yaml.dump(raw))
    const response = await f.request('/api/relay/device-operation', 'POST', { type: 'policy.get' })
    expect(response.status).toBe(failure === 'permission' ? 502 : 503)
    expect(await response.json()).toMatchObject({ error: { code: failure === 'permission' ? 'backend_auth_failed' : 'backend_version_unsupported' } })
    expect((await f.request('/api/auth/me')).status).toBe(200)
  })
})
