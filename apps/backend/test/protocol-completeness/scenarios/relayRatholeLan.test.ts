import { once } from 'node:events'
import { createServer as netServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { selectBusinessProtocols } from '@chery/protocol'
import { startService } from '@/service/index.js'
import { hashPassword } from '@/utils/password.js'
import { closeAllConnections } from '@/service/websocket/index.js'
import { createRelayService } from '../../../../relay/src/server.js'
import { RelayBackendClient } from '../../../../relay/src/client.js'
import { startRathole } from '../../../../relay/src/rathole.js'

const host = '10.2.3.6'
const binary = process.env.LOGIN_RATHOLE_BINARY
async function freePort(): Promise<number> { const s = netServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = (s.address() as { port: number }).port; await new Promise<void>((resolve) => s.close(() => resolve())); return port }
async function wait(predicate: () => boolean) { const until = Date.now() + 20000; while (!predicate()) { if (Date.now() >= until) throw new Error('Real tunnel did not become ready'); await new Promise((r) => setTimeout(r, 50)) } }

describe('actual Relay / rathole / Backend LAN business path', () => {
  it.skipIf(!binary)('two devices use authenticated HTTP and WS, removing one keeps the other and revokes old browser session', async () => {
    const root = '/home/chery/.hermes/cache/scratch/login-development/relay-rathole/' + randomBytes(12).toString('hex')
    await mkdir(root, { recursive: true })
    const keyResult = spawnSync(binary!, ['--genkey'], { encoding: 'utf8' })
    expect(keyResult.status).toBe(0)
    const privateKey = /Private Key:\s*(\S+)/.exec(keyResult.stdout)![1]!
    const publicKey = /Public Key:\s*(\S+)/.exec(keyResult.stdout)![1]!
    const controlPort = await freePort()
    const httpStart = await freePort(); const wsStart = await freePort()
    const previousSecret = process.env.CHERY_AUTH_SESSION_SECRET
    process.env.CHERY_AUTH_SESSION_SECRET = randomBytes(32).toString('hex')
    const backends = ['device-alpha', 'device-beta'].map(() => startService({ port: 0, webPort: 0, host: '0.0.0.0', businessPreset: 'basic', auth: { username: 'business', password: hashPassword('synthetic-business-password') }, remote: { httpPort: 0, websocketPort: 0 } }))
    const config = { host: '0.0.0.0', port: 0, publicOrigin: 'http://10.2.3.6:4080', publicBasePath: '/nyxus', identityFile: root + '/identities.json', authorizationFile: root + '/authorizations.json', sessionTtlSeconds: 300, challengeTtlMs: 5000, heartbeatIntervalMs: 1000, leaseTtlMs: 15000, tunnelHttpPortStart: httpStart, tunnelWebsocketPortStart: wsStart, limits: { maxOnlineBackends: 10, maxControlConnections: 10, maxBrowserWebSockets: 10, maxWebSocketsPerBackend: 10, maxConcurrentHttp: 10, maxRequestBytes: 65536, requestsPerMinutePerIp: 1000, upstreamTimeoutMs: 5000 }, rathole: { configFile: root + '/server.toml', bindAddr: `${host}:${controlPort}`, transport: '[server.transport]\ntype = "noise"\n[server.transport.noise]\nlocal_private_key = ' + JSON.stringify(privateKey) + '\n' } }
    const relay = await createRelayService({ config, logger: () => {} })
    const address = await relay.listen(); config.publicOrigin = `http://${host}:${address.port}`
    const serverProcess = startRathole(binary!, config.rathole.configFile)
    const clients: RelayBackendClient[] = []; let socket: WebSocket | undefined
    try {
      for (let index = 0; index < 2; index++) {
        const backend = backends[index]!; const ports = await backend.ready
        const id = index === 0 ? 'device-alpha' : 'device-beta'
        // The Backend issues a probe-only token; this is not a business or machine credential.
        const auth = (await import('@/service/auth/index.js')).OAuth2Auth
        const probe = new auth({ username: 'business', password: hashPassword('synthetic-business-password') })
        // Both fixtures share an injected auth signing secret through the test environment.
        const client = new RelayBackendClient({ url: `ws://${host}:${address.port}/nyxus/control/backend`, backendId: id, displayName: id, configVersion: 1, keyFile: root + '/' + id + '.json', ratholeServerAddr: `${host}:${controlPort}`, ratholeConfigPath: root + '/' + id + '.toml', ratholeBinary: binary!, onStatus: (status, error) => console.log('DEVICE', id, status, error ?? ''), encryptedTransport: '[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = ' + JSON.stringify(publicKey) + '\n', tunnelAddresses: { httpLocalAddr: `127.0.0.1:${ports.remote!.httpPort}`, websocketLocalAddr: `127.0.0.1:${ports.remote!.websocketPort}` }, tunnelBindAddresses: { httpBindAddr: '127.0.0.1:42000', wsBindAddr: '127.0.0.1:43000' }, probeToken: () => probe.tunnelProbeToken() })
        clients.push(client); await client.start(); await wait(() => client.getStatus() === 'online')
      }
      const base = config.publicOrigin + '/nyxus'
      async function login(id: string) {
        const d = await fetch(base + '/api/auth/capabilities'); const discovery = await d.json() as any; let cookie = d.headers.get('set-cookie')!.split(';')[0]!
        const response = await fetch(base + '/api/browser-session/password', { method: 'POST', headers: { Cookie: cookie, Origin: config.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': discovery.csrfToken }, body: JSON.stringify({ backendId: id, username: 'business', password: 'synthetic-business-password', operationId: randomBytes(24).toString('hex') }) })
        expect(response.status).toBe(200); cookie = response.headers.get('set-cookie')!.split(';')[0]!
        return { cookie, view: await response.json() as any }
      }
      const alpha = await login('device-alpha'); const beta = await login('device-beta')
      const read = (id: string, cookie: string) => fetch(base + '/backend/' + id + '/api/config', { headers: { Cookie: cookie } })
      const a = await (await read('device-alpha', alpha.cookie)).json() as any
      const b = await (await read('device-beta', beta.cookie)).json() as any
      expect(a.bootstrap.instanceId).not.toBe(b.bootstrap.instanceId)
      expect(a.bootstrap.preset).toBe('basic'); expect(a.bootstrap.software).toEqual({ backend: { version: '1.0.0' }, relay: { version: '1.0.0' } })
      const ticketResponse = await fetch(base + '/api/browser-session/ws-ticket', { method: 'POST', headers: { Cookie: alpha.cookie, Origin: config.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': alpha.view.csrfToken }, body: JSON.stringify({ expectedRevision: alpha.view.revision }) })
      expect(ticketResponse.status).toBe(200); const ticket = await ticketResponse.json() as any
      socket = new WebSocket(config.publicOrigin.replace('http:', 'ws:') + ticket.wsPath + '?ticket=' + ticket.ticket + '&' + new URLSearchParams(Object.entries(selectBusinessProtocols(a.bootstrap)).map(([k, v]) => [k, String(v)])), { origin: config.publicOrigin })
      await once(socket, 'open')
      const response = new Promise<any>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Business RPC timeout')), 5000); socket!.on('message', (data) => { const v = JSON.parse(data.toString()); if (v.requestId === 'business-read') { clearTimeout(timeout); resolve(v) } }) })
      socket.send(JSON.stringify({ kind: 'request', id: 'business-read', method: 'chat.list', params: { scope: 'stage' } }))
      expect(await response).toMatchObject({ success: true })
      // Policy revocation is an explicit authenticated device operation, not a mock health change.
      const revoked = once(socket, 'close'); await clients[0]!.deviceOperation('policy.set', { publicDiscovery: true, remotePasswordEnabled: false }); expect((await revoked)[0]).toBe(4003)
      expect((await fetch(base + '/api/browser-session', { headers: { Cookie: alpha.cookie } })).status).toBe(401)
      expect((await read('device-beta', beta.cookie)).status).toBe(200)
      await clients[0]!.deviceOperation('policy.set', { publicDiscovery: true, remotePasswordEnabled: true }); const alphaAgain = await login('device-alpha')
      const originalBeta = relay.registry.tunnelAddresses('device-beta')
      await Promise.all([clients[0]!.stop(), clients[1]!.deviceOperation('policy.get')]); await wait(() => relay.registry.get('device-alpha')?.status === 'offline')
      await clients[0]!.start(); await wait(() => clients[0]!.getStatus() === 'online'); expect(relay.registry.tunnelAddresses('device-beta')).toEqual(originalBeta); expect((await read('device-beta', beta.cookie)).status).toBe(200)
      expect((await fetch(base + '/api/browser-session', { headers: { Cookie: alphaAgain.cookie } })).status).toBe(401)
      const alphaThird = await login('device-alpha'); const freshTicketResponse = await fetch(base + '/api/browser-session/ws-ticket', { method: 'POST', headers: { Cookie: alphaThird.cookie, Origin: config.publicOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': alphaThird.view.csrfToken }, body: JSON.stringify({ expectedRevision: alphaThird.view.revision }) }); const freshTicket = await freshTicketResponse.json() as any
      socket = new WebSocket(config.publicOrigin.replace('http:', 'ws:') + freshTicket.wsPath + '?ticket=' + freshTicket.ticket + '&' + new URLSearchParams(Object.entries(selectBusinessProtocols(a.bootstrap)).map(([k, v]) => [k, String(v)])), { origin: config.publicOrigin }); await once(socket, 'open')
      const closed = once(socket, 'close'); await clients[0]!.stop(); expect([4003, 1011]).toContain((await closed)[0])
      await wait(() => relay.registry.get('device-alpha')?.status === 'offline')
      expect((await read('device-beta', beta.cookie)).status).toBe(200)
      expect((await fetch(base + '/api/browser-session', { headers: { Cookie: alpha.cookie } })).status).toBe(401)
    } finally {
      if (previousSecret === undefined) delete process.env.CHERY_AUTH_SESSION_SECRET; else process.env.CHERY_AUTH_SESSION_SECRET = previousSecret
      socket?.terminate(); for (const client of clients) await client.stop()
      await relay.close(); await serverProcess.stop()
      for (const backend of backends) { await backend.stopIngress(); backend.stopSchedule(); closeAllConnections(backend.wss); if (backend.remoteWss) closeAllConnections(backend.remoteWss); await Promise.all([new Promise<void>((r) => backend.wss.close(() => r())), new Promise<void>((r) => backend.httpServer.close(() => r())), new Promise<void>((r) => backend.remoteWss!.close(() => r())), new Promise<void>((r) => backend.remoteHttpServer!.close(() => r()))]) }
    }
  }, 60000)
})
