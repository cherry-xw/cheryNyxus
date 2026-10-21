import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startService } from '@/service/index'
import { hashPassword } from '@/utils/password'
import { closeAllConnections } from '@/service/websocket'
import { selectBusinessProtocols } from '@chery/protocol'
// @ts-expect-error deployment JavaScript has no declarations
import { createWebServer } from '../../../../web/deploy/docker/web-server.mjs'
const host = '10.2.3.6'
describe('F03 real deployment proxy → Backend browser auth → business', () => {
  it.each(['', '/nyxus'])('preserves login, single-use ticket, selection and Lite query at prefix %s', async (prefix) => {
    const root = '/home/chery/.hermes/cache/scratch/login-development/proxy-business-' + randomBytes(12).toString('hex'); await mkdir(root, { recursive: true }); await writeFile(root + '/index.html', 'isolated-shell')
    // Fixed fixture public origin lets trusted proxy forward Host without production configuration.
    const origin = 'http://10.2.3.6:49001'
    const backend = startService({ port: 0, webPort: 0, host: '0.0.0.0', businessPreset: 'basic', auth: { username: 'business', password: hashPassword('synthetic-business-password'), machine: { username: '', password: 'invalid-machine-only' }, browserDeployment: { origin, basePath: prefix } } })
    const ports = await backend.ready
    const proxy = createWebServer({ root, backendHttp: `http://${host}:${ports.local.httpPort}`, backendWs: `http://${host}:${ports.local.websocketPort}/ws`, basePath: prefix })
    proxy.listen(0, '0.0.0.0'); await once(proxy, 'listening'); const base = `http://${host}:${(proxy.address() as { port: number }).port}`, sockets: WebSocket[] = []
    try {
      expect(await (await fetch(base + prefix + '/')).text()).toBe('isolated-shell')
      const deniedMachine = await fetch(`http://${host}:${ports.local.httpPort}/api/machine/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'machine', password: 'synthetic-machine-password' }) }); expect(deniedMachine.status).toBe(401)
      const discoveryResponse = await fetch(base + prefix + '/api/auth/capabilities'), discovery = await discoveryResponse.json() as any
      let Cookie = discoveryResponse.headers.get('set-cookie')!.split(';')[0]!
      const post = (path: string, value: unknown, csrf = discovery.csrfToken) => fetch(base + prefix + path, { method: 'POST', headers: { Cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(value) })
      const login = await post('/api/browser-session/password', { username: 'business', password: 'synthetic-business-password', operationId: randomBytes(24).toString('base64url') }); expect(login.status).toBe(200)
      Cookie = login.headers.get('set-cookie')!.split(';')[0]!; const session = await login.json() as any
      const configResponse = await fetch(base + prefix + '/api/config', { headers: { Cookie } }); expect(configResponse.status).toBe(200); const config = await configResponse.json() as any
      const selected = selectBusinessProtocols(config.bootstrap)
      const response = await post('/api/browser-session/ws-ticket', { expectedRevision: session.revision }, session.csrfToken); expect(response.status).toBe(200); const ticket = await response.json() as any
      const query = new URLSearchParams(Object.entries(selected).map(([k, v]) => [k, String(v)])); query.set('ticket', ticket.ticket); query.set('profile', 'lite'); query.set('v', '1'); query.set('maxFrameBytes', '512'); query.set('turnDelta', '1')
      const url = base.replace('http:', 'ws:') + ticket.wsPath + '?' + query
      const ws = new WebSocket(url, { origin }); sockets.push(ws); await once(ws, 'open')
      const reply = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('RPC timeout')), 5000); ws.on('message', (v) => { const data = JSON.parse(String(v)); if (data.requestId === 'proxy-business') { clearTimeout(timer); expect(Buffer.byteLength(String(v))).toBeLessThanOrEqual(512); resolve(data) } }) })
      ws.send(JSON.stringify({ kind: 'request', id: 'proxy-business', method: 'chat.list', params: { scope: 'stage' } })); expect(await reply).toMatchObject({ success: true })
      async function refused(target: string) { const s = new WebSocket(target, { origin }); sockets.push(s); return new Promise<boolean>((r) => { s.once('error', () => r(true)); s.once('open', () => { s.terminate(); r(false) }) }) }
      expect(await refused(url)).toBe(true)
      for (const bad of ['/wrong/ws?' + query, ticket.wsPath + '?' + query + '&ticket=duplicate', ticket.wsPath + '?' + query + '&unknown=1']) expect(await refused(base.replace('http:', 'ws:') + bad)).toBe(true)
      if (prefix) expect((await fetch(base + '/wrong/api/config', { headers: { Cookie } })).status).toBe(404) // root SPA routes are not an API proxy
    } finally {
      for (const ws of sockets) ws.terminate(); await new Promise<void>((r) => proxy.close(() => r())); await backend.stopIngress(); backend.stopSchedule(); closeAllConnections(backend.wss); await Promise.all([new Promise<void>((r) => backend.wss.close(() => r())), new Promise<void>((r) => backend.httpServer.close(() => r()))])
    }
  })
})
