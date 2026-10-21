import { once, EventEmitter } from 'node:events'
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { createRelayService } from '../src/server'
import { IdentityStore } from '../src/identityStore'
import { RelayBackendClient } from '../src/client'
import { AuthorizationStore } from '../src/authorizationStore'
import { RatholeLeaseManager } from '../src/ratholeLeaseManager'
import { relaySignaturePayload } from '@chery/protocol'
const config = { host: '0.0.0.0', port: 0, publicOrigin: 'http://10.2.3.6:4080', publicBasePath: '', challengeTtlMs: 10000, heartbeatIntervalMs: 1000, leaseTtlMs: 30000, sessionTtlSeconds: 300, limits: { maxOnlineBackends: 10, maxControlConnections: 10, maxBrowserWebSockets: 10, maxWebSocketsPerBackend: 10, maxConcurrentHttp: 10, maxRequestBytes: 65536, requestsPerMinutePerIp: 1000, upstreamTimeoutMs: 1000 } }
const transport = '[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = "' + Buffer.alloc(32, 7).toString('base64') + '"\n'
function gate() { let release!: () => void; return { promise: new Promise<void>((r) => { release = r }), release: () => release() } }
async function hello(url: string, id: string, keys = generateKeyPairSync('ed25519')) {
  const socket = new WebSocket(url); const messages: any[] = []; socket.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  await vi.waitFor(() => expect(messages[0]?.type).toBe('challenge'))
  const nonce = messages[0].nonce
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, backendId: id, displayName: id, configVersion: 1, capabilities: { http: true, websocket: true }, publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), signature: sign(null, Buffer.from(relaySignaturePayload({ nonce, backendId: id, protocolVersion: 2, configVersion: 1 })), keys.privateKey).toString('base64url') }))
  return { socket, messages, keys }
}
describe('F07 forced control and lease interleavings', () => {
  it('close during delayed add releases only old lease while beta stays ready', async () => {
    const delay = gate(), entered = gate(), added: any[] = [], removed: string[] = []
    const service = await createRelayService({ config, identityStore: new IdentityStore(), logger: () => {}, leaseManager: { async initialize() {}, async add(v) { added.push(v); if (v.backendId === 'device-alpha') { entered.release(); await delay.promise } }, async remove(id) { removed.push(id) } }, adapter: { async forwardHttp() { return { status: 200, headers: {}, body: Buffer.from('{}') } }, acceptWebSocket() {} } })
    const address = await service.listen(), url = `ws://10.2.3.6:${address.port}/control/backend`
    const alpha = await hello(url, 'device-alpha'); await entered.promise
    const beta = await hello(url, 'device-beta'); await vi.waitFor(() => expect(beta.messages.some((v) => v.type === 'accepted')).toBe(true)); const betaLease = beta.messages.find((v) => v.type === 'accepted').leaseId
    beta.socket.send(JSON.stringify({ type: 'tunnel.applied', leaseId: betaLease, probeToken: 'p'.repeat(32) })); await vi.waitFor(() => expect(service.registry.get('device-beta')?.status === 'online').toBe(true))
    try {
      const closed = once(alpha.socket, 'close'); alpha.socket.close(); await closed; delay.release()
      await vi.waitFor(() => expect(removed).toContain(added.find((v) => v.backendId === 'device-alpha').leaseId))
      expect(alpha.messages.some((v) => v.type === 'accepted')).toBe(false); expect((service.registry.get('device-alpha')?.status === 'online')).toBe(false); expect(service.registry.get('device-beta')?.status === 'online').toBe(true); expect(removed).not.toContain(betaLease)
    } finally { delay.release(); alpha.socket.terminate(); beta.socket.terminate(); await service.close() }
  })
  it('late old probe and stale ACK cannot ready or kill replacement lease', async () => {
    const delayed = gate(), entered = gate(); let first = true
    const service = await createRelayService({ config, logger: () => {}, identityStore: new IdentityStore(), adapter: { async forwardHttp() { if (first) { first = false; entered.release(); await delayed.promise }; return { status: 200, headers: {}, body: Buffer.from('{}') } }, acceptWebSocket() {} } })
    const address = await service.listen(), url = `ws://10.2.3.6:${address.port}/control/backend`, old = await hello(url, 'device-alpha')
    await vi.waitFor(() => expect(old.messages.some((v) => v.type === 'accepted')).toBe(true)); const oldLease = old.messages.find((v) => v.type === 'accepted').leaseId
    old.socket.send(JSON.stringify({ type: 'tunnel.applied', leaseId: oldLease, probeToken: 'p'.repeat(32) })); await entered.promise; const closed = once(old.socket, 'close'); old.socket.close(); await closed
    const current = await hello(url, 'device-alpha', old.keys); await vi.waitFor(() => expect(current.messages.some((v) => v.type === 'accepted')).toBe(true)); const lease = current.messages.find((v) => v.type === 'accepted').leaseId
    try {
      current.socket.send(JSON.stringify({ type: 'authorizations.ack', revision: 'old-ack'.padEnd(32, 'x') })); delayed.release(); await new Promise((r) => setTimeout(r, 30)); expect((service.registry.get('device-alpha')?.status === 'online')).toBe(false); expect(current.socket.readyState).toBe(WebSocket.OPEN)
      current.socket.send(JSON.stringify({ type: 'tunnel.applied', leaseId: lease, probeToken: 'p'.repeat(32) })); await vi.waitFor(() => expect((service.registry.get('device-alpha')?.status === 'online')).toBe(true)); expect(lease).not.toBe(oldLease); expect(old.messages.some((v) => v.type === 'tunnel.ready')).toBe(false)
    } finally { delayed.release(); old.socket.terminate(); current.socket.terminate(); await service.close() }
  })
  it('two concurrent revocations merge behind initial ACK; repeated old ACK cannot clear next snapshot or affect beta', async () => {
    const root = await mkdtemp('/home/chery/.hermes/cache/scratch/login-development/ack-'), store = new AuthorizationStore(root + '/auth.json', { confirmationBaseUrl: 'https://relay.example' }), keys = generateKeyPairSync('ed25519')
    const bindings: string[] = []
    for (const subject of ['one', 'two']) { const request = await store.createBindingRequest({ backendId: 'device-alpha', displayName: 'Alpha', publicKeyFingerprint: 'f'.repeat(43) }); bindings.push((await store.confirmBindingRequest(request.requestId, { issuer: 'https://id.example', subject })).bindingId) }
    const service = await createRelayService({ config: { ...config, adminSecret: 'synthetic-admin', authorizationFile: root + '/auth.json', userProof: { issuer: 'https://relay.example', kid: 'k'.repeat(32), privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() } }, identityStore: new IdentityStore(), logger: () => {} })
    const address = await service.listen(), url = `ws://10.2.3.6:${address.port}/control/backend`, alpha = await hello(url, 'device-alpha'), beta = await hello(url, 'device-beta')
    await vi.waitFor(() => expect(alpha.messages.some((v) => v.type === 'authorizations.snapshot')).toBe(true)); await vi.waitFor(() => expect(beta.messages.some((v) => v.type === 'authorizations.snapshot')).toBe(true))
    try {
      // Both persistent relationships are owned by the live Relay store.
      await Promise.all(bindings.map(async (bindingId) => { const response = await fetch(`http://10.2.3.6:${address.port}/api/admin/bindings/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-chery-relay-admin-token': 'synthetic-admin' }, body: JSON.stringify({ bindingId }) }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ revoked: true }) }))
      const initial = alpha.messages.find((v) => v.type === 'authorizations.snapshot').revision
      alpha.socket.send(JSON.stringify({ type: 'authorizations.ack', revision: initial })); await vi.waitFor(() => expect(alpha.messages.filter((v) => v.type === 'authorizations.snapshot')).toHaveLength(2)); const next = alpha.messages.filter((v) => v.type === 'authorizations.snapshot')[1]; expect(next.revision).not.toBe(initial); expect(next.authorizations).toEqual([])
      expect(alpha.socket.readyState).toBe(WebSocket.OPEN); expect(beta.socket.readyState).toBe(WebSocket.OPEN)
      alpha.socket.send(JSON.stringify({ type: 'authorizations.ack', revision: initial })); await new Promise((r) => setTimeout(r, 30)); expect(alpha.socket.readyState).toBe(WebSocket.OPEN); expect(alpha.messages.filter((v) => v.type === 'authorizations.snapshot')).toHaveLength(2); alpha.socket.send(JSON.stringify({ type: 'authorizations.ack', revision: next.revision })); expect(beta.messages.filter((v) => v.type === 'authorizations.snapshot')).toHaveLength(1)
    } finally { alpha.socket.terminate(); beta.socket.terminate(); await service.close() }
  })
  it('serial global snapshot keeps beta during delayed alpha add/remove and does not cross tokens', async () => {
    const root = await mkdtemp('/home/chery/.hermes/cache/scratch/login-development/lease-'), delay = gate(), entered = gate(), snapshots: any[] = []
    const manager = new RatholeLeaseManager(root + '/server.toml', '127.0.0.1:1', async (v) => { snapshots.push(v); if (snapshots.length === 1) { entered.release(); await delay.promise } }, '[server.transport]\ntype = "noise"\n[server.transport.noise]\nlocal_private_key = "' + Buffer.alloc(32, 8).toString('base64') + '"\n')
    const lease = (backendId: string, port: number) => ({ type: 'accepted' as const, protocolVersion: 2 as const, backendId, configVersion: 1, leaseId: randomBytes(24).toString('base64url'), heartbeatIntervalMs: 1000, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), tunnel: { httpService: backendId + '-http-service', websocketService: backendId + '-websocket-service', token: randomBytes(24).toString('base64url'), httpBindAddr: `127.0.0.1:${port}`, websocketBindAddr: `127.0.0.1:${port + 1}` } })
    const alpha = lease('device-alpha', 49991), beta = lease('device-beta', 49993)
    await manager.initialize(); const a = manager.add(alpha); await entered.promise; const b = manager.add(beta), remove = manager.remove(alpha.leaseId); delay.release(); await Promise.all([a, b, remove])
    expect(snapshots.map((v) => v.services.length)).toEqual([2, 4, 2]); const text = await readFile(root + '/server.toml', 'utf8'); expect(text).toContain(beta.tunnel.token); expect(text).not.toContain(alpha.tunnel.token); expect(text).not.toContain(alpha.tunnel.httpService)
  })
  it('client accepted waiting for old process stop cannot spawn after replacement/stop', async () => {
    class Socket extends EventEmitter { readyState: number = WebSocket.OPEN; sent: any[] = []; send(raw: string) { this.sent.push(JSON.parse(raw)) } close() { this.readyState = WebSocket.CLOSED; this.emit('close') } }
    const root = await mkdtemp('/home/chery/.hermes/cache/scratch/login-development/accepted-'), sockets: Socket[] = [], blocked = gate(), entered = gate(); let spawned = 0
    const client = new RelayBackendClient({ url: 'ws://isolated.invalid/control/backend', backendId: 'device-alpha', displayName: 'Alpha', configVersion: 1, keyFile: root + '/key.json', ratholeConfigPath: root + '/client.toml', ratholeServerAddr: 'relay.example:2333', tunnelAddresses: { httpLocalAddr: '127.0.0.1:1', websocketLocalAddr: '127.0.0.1:2' }, tunnelBindAddresses: { httpBindAddr: '127.0.0.1:42000', wsBindAddr: '127.0.0.1:43000' }, encryptedTransport: transport, probeToken: () => 'p'.repeat(32), reconnectMinMs: 1, webSocketFactory: () => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket }, ratholeProcessFactory: () => { spawned++; return { process: new EventEmitter() as ChildProcess, stop: async () => { entered.release(); await blocked.promise } } } })
    const accepted = (id: string) => ({ type: 'accepted', protocolVersion: 2, backendId: 'device-alpha', leaseId: id.repeat(32), heartbeatIntervalMs: 1000, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), configVersion: 1, tunnel: { httpService: 'http-' + id.repeat(32), websocketService: 'ws-' + id.repeat(32), token: 't'.repeat(32), httpBindAddr: '127.0.0.1:42000', websocketBindAddr: '127.0.0.1:43000' } })
    await client.start(); sockets[0]!.emit('message', Buffer.from(JSON.stringify(accepted('a'))), false); await vi.waitFor(() => expect(spawned).toBe(1)); sockets[0]!.emit('message', Buffer.from(JSON.stringify({ type: 'tunnel.ready', leaseId: 'a'.repeat(32) })), false); await vi.waitFor(() => expect(client.getStatus()).toBe('online'))
    sockets[0]!.emit('message', Buffer.from(JSON.stringify(accepted('b'))), false); await entered.promise; sockets[0]!.close(); await vi.waitFor(() => expect(sockets.length).toBe(2)); blocked.release(); await client.stop(); expect(spawned).toBe(1); expect(client.getStatus()).toBe('stopped')
  })
})
