import { once } from 'node:events'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { createRelayService } from '../src/server.js'
import { RELAY_PROTOCOL_VERSION, relaySignaturePayload } from '@chery/protocol/relay'
import type { RelayTargetAdapter } from '../src/adapter.js'

// Synthetic upstream only: this verifies the actual Relay LAN boundary, not rathole/Pocket.
const adapter: RelayTargetAdapter = {
  async forwardHttp(input) {
    let result: unknown = { authenticated: true }
    if (input.path === '/api/auth/challenge') result = { challengeId: 'synthetic', nonce: 'synthetic-nonce' }
    if (input.path === '/api/auth/login') result = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(result)) }
  },
  async acceptWebSocket() { throw new Error('Not part of this isolated test') },
}
describe('Relay LAN browser and self-service boundaries', () => {
  it('signs device identity, reads and saves own policy, cancels binding, enforces Cookie/CSRF/CAS and forbids auth proxy paths', async () => {
    const service = await createRelayService({ adapter, logger: () => {}, config: { host: '0.0.0.0', port: 0, publicOrigin: 'http://10.2.3.6:4080', publicBasePath: '/nyxus', sessionTtlSeconds: 300, challengeTtlMs: 3000, heartbeatIntervalMs: 30000, leaseTtlMs: 60000, limits: { maxOnlineBackends: 10, maxControlConnections: 10, maxBrowserWebSockets: 10, maxWebSocketsPerBackend: 10, maxConcurrentHttp: 10, maxRequestBytes: 65536, requestsPerMinutePerIp: 100, upstreamTimeoutMs: 1000 } } })
    let ws: WebSocket | undefined
    try {
      const address = await service.listen(); const base = `http://10.2.3.6:${address.port}/nyxus`; const origin = 'http://10.2.3.6:4080'
      ws = new WebSocket(`ws://10.2.3.6:${address.port}/nyxus/control/backend`)
      const [raw] = await once(ws, 'message'); const challenge = JSON.parse(String(raw))
      const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const der = publicKey.export({ format: 'der', type: 'spki' })
      const accepted = once(ws, 'message')
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: RELAY_PROTOCOL_VERSION, backendId: 'home-nyxus', displayName: 'Home', publicKey: der.toString('base64url'), signature: sign(null, Buffer.from(relaySignaturePayload({ nonce: challenge.nonce, backendId: 'home-nyxus', protocolVersion: RELAY_PROTOCOL_VERSION, configVersion: 1 })), privateKey).toString('base64url'), configVersion: 1, capabilities: { http: true, websocket: true } }))
      const lease = JSON.parse(String((await accepted)[0])); expect(lease.type).toBe('accepted')
      const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'tunnel.applied', leaseId: lease.leaseId, probeToken: 'synthetic-probe-token' })); expect(JSON.parse(String((await ready)[0])).type).toBe('tunnel.ready')
      let sequence = 0
      async function operation(type: string, input: Record<string, unknown> = {}) { const result = once(ws!, 'message'); ws!.send(JSON.stringify({ type, requestId: (++sequence).toString().padStart(32, 'a'), ...input })); return JSON.parse(String((await result)[0])).request }
      expect((await operation('policy.set', { publicDiscovery: true, remotePasswordEnabled: true })).backendId).toBe('home-nyxus')
      expect((await operation('policy.get')).publicDiscovery).toBe(true)
      const binding = await operation('binding.request', { backendId: 'home-nyxus', deviceFingerprint: createHash('sha256').update(der).digest('base64url'), requestedPermission: 'business' })
      expect(binding.status).toBe('pending')
      expect((await operation('binding.cancel', { bindingRequestId: binding.requestId })).status).toBe('cancelled')
      const capabilities = await fetch(base + '/api/auth/capabilities'); const discovery = await capabilities.json() as any
      let cookie = capabilities.headers.get('set-cookie')!.split(';')[0]!
      const body = { backendId: 'home-nyxus', username: 'synthetic-user', password: 'synthetic-password', operationId: 'p'.repeat(32) }
      const write = (path: string, method: string, value: unknown, csrf = discovery.csrfToken, source = origin) => fetch(base + path, { method, headers: { Cookie: cookie, Origin: source, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(value) })
      expect((await write('/api/browser-session/password', 'POST', body, 'wrong')).status).toBe(403)
      expect((await write('/api/browser-session/password', 'POST', body, discovery.csrfToken, origin + ':1')).status).toBe(403)
      const login = await write('/api/browser-session/password', 'POST', body); expect(login.status).toBe(200)
      const session = await login.json() as any; cookie = login.headers.get('set-cookie')!.split(';')[0]!
      expect(session).not.toHaveProperty('accessToken')
      expect((await write('/api/browser-session/password', 'POST', body)).status).toBe(200)
      expect((await write('/api/browser-session/target', 'PUT', { backendId: 'other-nyxus', expectedRevision: 1, operationId: 't'.repeat(32) }, session.csrfToken)).status).toBe(403)
      for (const path of ['/api/machine/login', '/api/auth/login', '/api/browser-session']) expect((await fetch(base + '/backend/home-nyxus' + path, { headers: { Cookie: cookie } })).status).toBe(400)
      const logout = { expectedRevision: 1, operationId: 'd'.repeat(32) }
      expect((await write('/api/browser-session', 'DELETE', logout, session.csrfToken)).status).toBe(204)
      expect((await write('/api/browser-session', 'DELETE', logout, session.csrfToken)).status).toBe(204)
    } finally { ws?.terminate(); await service.close() }
  })
})
