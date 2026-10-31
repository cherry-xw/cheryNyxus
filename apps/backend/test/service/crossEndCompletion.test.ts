import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { OAuth2Auth } from '../../src/service/auth'
import { hashPassword } from '../../src/utils/password'
import { RpcRouter } from '../../src/service/message/router'
import { createWebSocketServer } from '../../src/service/websocket'
import { BackendCapabilities } from '../../src/service/capabilities'
import { BootstrapSchema, selectBusinessProtocols, assertBusinessSelection, MachineMaintenanceSchema, PublicAuthCapabilitiesSchema, RelayClientStatusSchema } from '@chery/protocol'
import { UserProofSigner } from '../../../relay/src/userProof'
const base = () => new BackendCapabilities('basic').snapshot()
describe('F04 independent domains and bound business negotiation', () => {
  it('selects domain intersections independent of software versions and unused relay control range', () => {
    const value = BootstrapSchema.parse({ ...base(), software: { backend: { version: 'different-backend', buildId: 'build' }, relay: { version: 'different-relay' } }, protocolRanges: { bootstrap: { min: 1, max: 3 }, websocket: { min: 1, max: 3 }, relay: { min: 55, max: 55 } } })
    expect(selectBusinessProtocols(value)).toMatchObject({ bootstrapVersion: 1, protocolVersion: 1 })
    for (const domain of ['bootstrap', 'websocket']) expect(() => selectBusinessProtocols(BootstrapSchema.parse({ ...value, protocolRanges: { ...value.protocolRanges, [domain]: { min: 2, max: 2 } } }))).toThrow('交集')
  })
  it('rejects tampered selection, instance/revision, nested software and missing required domain', () => {
    const value = base(), selection = selectBusinessProtocols(value)
    const url = (s: object) => new URL('/ws?' + new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)])), 'http://internal.invalid')
    expect(() => assertBusinessSelection(url(selection), value)).not.toThrow()
    for (const change of [{ protocolVersion: 2 }, { bootstrapVersion: 2 }, { instanceId: 'another' }, { capabilityRevision: 'another' }]) expect(() => assertBusinessSelection(url({ ...selection, ...change }), value)).toThrow()
    expect(() => assertBusinessSelection(url({ protocolVersion: 1 }), value)).toThrow()
    expect(BootstrapSchema.safeParse({ ...value, software: { backend: { version: 'v', secret: 'reject' } } }).success).toBe(false)
    expect(BootstrapSchema.safeParse({ ...value, protocolRanges: { relay: { min: 2, max: 2 } } }).success).toBe(false)
  })
  it('actual LAN WS accepts bound ticket, refuses wrong binding before ticket consume; channel requires no Web negotiation', async () => {
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('synthetic-business-password') }), capabilities = new BackendCapabilities('basic'), router = new RpcRouter()
    router.register('brain.list', async () => ({ brains: [], mcpServers: [] }))
    const wss = createWebSocketServer({ port: 0, host: '0.0.0.0', auth, router, bootstrap: () => capabilities.snapshot(), channelAuth: { token: 'synthetic-channel-secret', header: 'x-test-channel', credentialKind: 'isolated-channel' } })
    await once(wss, 'listening'); const origin = `http://10.2.3.6:${(wss.address() as { port: number }).port}`, wsBase = origin.replace('http:', 'ws:')
    const record = auth.browser.store.create({ identity: { provider: 'password', subject: 'business' }, mode: 'direct-password', target: { origin, basePath: '', httpBasePath: '', wsPath: '/ws' } })
    const ticket = auth.browser.store.ticket(record.id, 1).ticket, selection = selectBusinessProtocols(capabilities.snapshot()), sockets: WebSocket[] = []
    const query = new URLSearchParams(Object.entries(selection).map(([k, v]) => [k, String(v)])); query.set('ticket', ticket)
    try {
      const wrong = new URLSearchParams(query); wrong.set('instanceId', 'wrong-instance')
      const rejected = new WebSocket(wsBase + '/ws?' + wrong, { origin }); sockets.push(rejected); rejected.on('error', () => {})
      expect(await new Promise<number>((r) => rejected.on('unexpected-response', (_q, res) => { res.resume(); r(res.statusCode!); rejected.terminate() }))).toBe(401)
      const ws = new WebSocket(wsBase + '/ws?' + query, { origin }); sockets.push(ws); await once(ws, 'open')
      const reply = once(ws, 'message'); ws.send(JSON.stringify({ kind: 'request', id: 'bound', method: 'brain.list', params: {} })); expect(JSON.parse(String((await reply)[0]))).toMatchObject({ success: true })
      const channel = new WebSocket(wsBase + '/ws', { headers: { 'x-test-channel': 'synthetic-channel-secret' } }); sockets.push(channel); await once(channel, 'open')
      expect(channel.readyState).toBe(WebSocket.OPEN) // channel permission remains independent; not a Web business grant
    } finally { for (const ws of sockets) ws.terminate(); auth.browser.store.clear(); await new Promise<void>((r) => wss.close(() => r())) }
  })
})
describe('F08 optional maintenance identity diagnostics and business denial', () => {
  it.each([undefined, { username: '', password: 'invalid' }, { username: 'machine', password: hashPassword('synthetic-machine-password') }])('reports isolated maintenance state %# without exposing credentials', async (machine) => {
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('synthetic-business-password'), machine })
    expect(auth.maintenanceDiagnostic().status).toBe(machine ? machine.username ? 'configured' : 'invalid' : 'not_configured')
    expect(JSON.stringify(auth.maintenanceDiagnostic())).not.toContain('password')
    expect(auth.authenticate('business', 'synthetic-business-password')).not.toBeNull(); expect(auth.authenticate('business', 'wrong')).toBeNull()
    const http = createServer(async (req, res) => { if (await auth.handle(req, res, { allowLoopback: true })) return; res.writeHead(404).end() }); http.listen(0, '0.0.0.0'); await once(http, 'listening')
    try { const response = await fetch(`http://10.2.3.6:${(http.address() as { port: number }).port}/api/machine/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'machine', password: 'synthetic-machine-password' }) }); expect(response.status).toBe(machine?.username ? 200 : 401) }
    finally { await new Promise<void>((r) => http.close(() => r())) }
    expect(() => new OAuth2Auth({ username: 'business', password: 'broken', machine })).toThrow()
  })
})
describe('F06 proof cleanup cannot become password or loopback fallback', () => {
  it('revocation rejects newly signed proofs even with valid password token present', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'), kid = randomBytes(24).toString('base64url'), issuer = 'https://relay.example'
    const signer = new UserProofSigner(issuer, kid, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('synthetic-business-password'), userProof: { issuer, backendId: 'test-device', keys: { [kid]: publicKey.export({ format: 'pem', type: 'spki' }).toString() }, authorizations: [] } })
    const tokens = auth.authenticate('business', 'synthetic-business-password')!
    const request = () => ({ method: 'GET', url: '/ws', headers: { authorization: `Bearer ${tokens.accessToken}`, 'x-chery-relay-user-proof': signer.issue({ sub: 'user', aud: 'test-device', sessionId: 's'.repeat(32), authorizationId: 'binding', authorizationRevision: 1, permissions: ['business'] }, 'GET', '/ws') }, socket: { remoteAddress: '10.2.3.6' } }) as unknown as IncomingMessage
    auth.updateAuthorizations([{ id: 'binding', revision: 1, subject: 'user' }]); expect(auth.getUser(request(), { allowLoopback: false })?.sub).toBe('user')
    auth.updateAuthorizations([]); expect(auth.getUser(request(), { allowLoopback: false })).toBeNull()
    expect(auth.authenticate('business', 'synthetic-business-password')).not.toBeNull()
  })
})
describe('F13 strict bounded discovery and state shape', () => {
  it('separates public methods, permission and machine capability; rejects oversized and ambiguous fields', () => {
    const publicView = { service: 'backend', password: true, oidc: false, csrfToken: 'c'.repeat(32) }
    expect(PublicAuthCapabilitiesSchema.safeParse(publicView).success).toBe(true)
    for (const v of [{ ...publicView, csrfToken: 'x'.repeat(129) }, { ...publicView, password: 1 }, { ...publicView, operations: ['relay.binding'] }]) expect(PublicAuthCapabilitiesSchema.safeParse(v).success).toBe(false)
    const maintenance = { protocolVersion: 1, instanceId: 'machine-instance', protocolRange: { min: 1, max: 1 }, operations: [], listener: 'local', diagnostic: { status: 'invalid', code: 'MACHINE_CONFIG_INVALID' } }
    expect(MachineMaintenanceSchema.safeParse(maintenance).success).toBe(true)
    for (const v of [{ ...maintenance, instanceId: 'x'.repeat(129) }, { ...maintenance, operations: ['relay.binding', 'relay.binding'] }, { ...maintenance, permission: 'business' }, { ...maintenance, protocolRange: { min: 1, max: 2 } }]) expect(MachineMaintenanceSchema.safeParse(v).success).toBe(false)
    const state = { protocolVersion: 3, instanceId: 'i'.repeat(32), backendId: 'test-device', status: 'online', configVersion: 1, desiredRevision: 'new', appliedRevision: 'old', leaseId: 'l'.repeat(32), leaseExpiresAt: new Date(Date.now() + 45_000).toISOString(), updatedAt: new Date().toISOString() }
    expect(RelayClientStatusSchema.safeParse(state).success).toBe(false)
    expect(RelayClientStatusSchema.safeParse({ ...state, appliedRevision: 'new' }).success).toBe(true)
    expect(RelayClientStatusSchema.safeParse({ ...state, appliedRevision: 'new', leaseExpiresAt: undefined }).success).toBe(false)
  })
})
