import { once } from 'node:events'
import { createServer, type IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { OAuth2Auth } from '../../src/service/auth/index.js'
import { hashPassword } from '../../src/utils/password.js'

const HOST = '10.2.3.6'
describe('direct browser identity LAN isolation', () => {
  it('requires origin and CSRF, never returns backend tokens, CAS and single-use tickets close revoked sockets', async () => {
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('synthetic-business-password'), machine: { username: 'machine', password: hashPassword('synthetic-machine-password') } })
    const server = createServer(async (req, res) => {
      if (await auth.browser.handle(req, res, 0)) return
      if (await auth.handle(req, res, { allowLoopback: true })) return
      res.writeHead(404); res.end()
    })
    server.listen(0, '0.0.0.0'); await once(server, 'listening')
    const port = (server.address() as { port: number }).port; const base = `http://${HOST}:${port}`
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      try { const session = auth.browser.consumeTicket(req); wss.handleUpgrade(req, socket, head, (ws) => { const off = auth.browser.store.attach(session.id, ws); ws.once('close', off); wss.emit('connection', ws, req) }) } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n') }
    })
    let ws: WebSocket | undefined
    try {
      const discovered = await fetch(`${base}/api/auth/capabilities`); const capability = await discovered.json() as { csrfToken: string }; let cookie = discovered.headers.get('set-cookie')!.split(';')[0]!
      const loginBody = { username: 'business', password: 'synthetic-business-password', operationId: 'o'.repeat(32) }
      const write = (path: string, method: string, body: unknown, csrf = capability.csrfToken, origin = base) => fetch(base + path, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) })
      expect((await write('/api/browser-session/password', 'POST', loginBody, 'wrong')).status).toBe(403)
      expect((await write('/api/browser-session/password', 'POST', loginBody, capability.csrfToken, `http://${HOST}:${port + 1}`)).status).toBe(403)
      const login = await write('/api/browser-session/password', 'POST', loginBody); expect(login.status).toBe(200)
      expect(login.headers.get('set-cookie')).toContain('HttpOnly'); cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const session = await login.json() as { revision: number; csrfToken: string }
      expect((await write('/api/browser-session/password', 'POST', loginBody)).status).toBe(200)
      expect((await write('/api/browser-session/password', 'POST', { ...loginBody, password: 'changed' })).status).toBe(409)
      expect(session).not.toHaveProperty('accessToken'); expect(session).not.toHaveProperty('refreshToken')
      expect((await write('/api/browser-session/refresh', 'POST', { expectedRevision: 2, operationId: 'r'.repeat(32) }, session.csrfToken)).status).toBe(409)
      const ticketResponse = await write('/api/browser-session/ws-ticket', 'POST', { expectedRevision: session.revision }, session.csrfToken)
      expect(ticketResponse.status).toBe(200); const ticket = await ticketResponse.json() as { ticket: string }
      ws = new WebSocket(`ws://${HOST}:${port}/ws?ticket=${ticket.ticket}`, { origin: base }); await once(ws, 'open')
      const second = new WebSocket(`ws://${HOST}:${port}/ws?ticket=${ticket.ticket}`, { origin: base }); const refused = await new Promise<number>((resolve) => { second.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); second.terminate() }); second.on('error', () => {}) }); expect(refused).toBe(401)
      const closed = once(ws, 'close'); expect((await write('/api/browser-session', 'DELETE', { expectedRevision: 1, operationId: 'd'.repeat(32) }, session.csrfToken)).status).toBe(204); expect((await closed)[0]).toBe(4003)
      expect((await fetch(base + '/api/browser-session', { headers: { Cookie: cookie } })).status).toBe(401)
      const machineLogin = await fetch(base + '/api/machine/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'machine', password: 'synthetic-machine-password' }) })
      expect(machineLogin.status).toBe(200); const machine = await machineLogin.json() as { accessToken: string }
      const request = { headers: { authorization: `Bearer ${machine.accessToken}` }, socket: { remoteAddress: HOST }, url: '/ws' } as IncomingMessage
      expect(auth.getMachineUser(request)).not.toBeNull(); expect(auth.getUser(request, { allowLoopback: false })).toBeNull()
      expect(auth.getMachineUser({ ...request, headers: { ...request.headers, origin: base } } as IncomingMessage)).toBeNull()
    } finally { ws?.terminate(); auth.browser.store.clear(); wss.close(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
