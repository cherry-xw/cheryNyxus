import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { selectBusinessProtocols, type BrowserSession } from '@chery/protocol'
import { OAuth2Auth } from '../../src/service/auth/index.js'
import { BackendCapabilities } from '../../src/service/capabilities.js'
import { createHttpServer } from '../../src/service/http/index.js'
import { RpcRouter } from '../../src/service/message/router.js'
import { createWebSocketServer } from '../../src/service/websocket/index.js'
import { hashPassword } from '../../src/utils/password.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(basePath = '') {
  const deployment = { origin: 'http://127.0.0.1', basePath }
  const auth = new OAuth2Auth({ username: 'business', password: hashPassword('synthetic-password'), browserDeployment: deployment })
  const capabilities = new BackendCapabilities('basic')
  const router = new RpcRouter()
  const reads: Array<{ owner: string | undefined; params: unknown }> = []
  router.register('chat.list', async (context, params) => {
    reads.push({ owner: context.authenticatedUserId, params })
    return { chats: [], total: 0 }
  })
  const wss = createWebSocketServer({ port: 0, host: '127.0.0.1', auth, router, bootstrap: () => capabilities.snapshot() })
  await once(wss, 'listening')
  const http = createHttpServer({ webPort: 0, host: '127.0.0.1', auth, capabilities,
    wsPort: () => (wss.address() as { port: number }).port, webSocketServer: wss })
  await once(http, 'listening')
  deployment.origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const base = deployment.origin + basePath
  const sockets: WebSocket[] = []
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate()
    for (const socket of wss.clients) socket.terminate()
    auth.browser.store.clear()
    await Promise.all([
      new Promise<void>(resolve => wss.close(() => resolve())),
      new Promise<void>(resolve => http.close(() => resolve())),
    ])
  })
  let cookie = '', csrf = '', session: BrowserSession
  async function request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(5000),
      headers: { Origin: deployment.origin, Cookie: cookie,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    return response
  }
  async function login() {
    const discovery = await request('/api/auth/capabilities')
    csrf = (await discovery.json()).csrfToken
    const response = await request('/api/browser-session/password', 'POST', { username: 'business', password: 'synthetic-password', operationId: randomUUID() })
    expect(response.status).toBe(200)
    session = await response.json() as BrowserSession
    csrf = session.csrfToken
    expect(session).not.toHaveProperty('accessToken')
    return session
  }
  async function ticketUrl() {
    const response = await request('/api/config')
    expect(response.status).toBe(200)
    const config = await response.json()
    expect(config.wsUrl).toBe(deployment.origin.replace('http:', 'ws:') + basePath + '/ws')
    const ticketResponse = await request('/api/browser-session/ws-ticket', 'POST', { expectedRevision: session.revision })
    expect(ticketResponse.status).toBe(200)
    const ticket = await ticketResponse.json()
    expect(ticket.wsPath).toBe(basePath + '/ws')
    const selected = selectBusinessProtocols(config.bootstrap)
    const url = new URL(config.wsUrl)
    for (const [key, value] of Object.entries({ ...selected, ticket: ticket.ticket })) url.searchParams.set(key, String(value))
    return url
  }
  function socket(url: URL, origin: string | undefined = deployment.origin) {
    const ws = new WebSocket(url, { origin, headers: { Cookie: cookie }, handshakeTimeout: 3000 })
    sockets.push(ws)
    return ws
  }
  async function reject(url: URL, origin?: string) {
    const ws = socket(url, origin)
    return new Promise<number>((resolve, reject) => {
      ws.once('open', () => reject(new Error('Unexpected anonymous or mismatched business connection')))
      ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); ws.terminate() })
      ws.once('error', () => resolve(0))
    })
  }
  async function read(ws: WebSocket, params: unknown = { scope: 'stage', limit: 1, includePreview: false }) {
    const response = once(ws, 'message')
    ws.send(JSON.stringify({ id: randomUUID(), kind: 'request', method: 'chat.list', params }))
    return JSON.parse(String((await response)[0]))
  }
  return { auth, wss, http, reads, request, login, ticketUrl, socket, reject, read }
}

describe('same-origin browser login and business connection', () => {
  it.each(['', '/nyxus'])('uses the advertised HTTP-origin WS route, business identity and fresh tickets on reconnect: %j', async prefix => {
    const app = await fixture(prefix)
    await app.login()
    const first = app.socket(await app.ticketUrl())
    await once(first, 'open')
    expect(await app.read(first)).toMatchObject({ success: true, data: { chats: [] } })
    const closed = once(first, 'close')
    first.close()
    await closed
    const next = app.socket(await app.ticketUrl())
    await once(next, 'open')
    expect(await app.read(next)).toMatchObject({ success: true })
    expect(app.reads).toEqual(Array.from({ length: 2 }, () => ({ owner: 'business', params: { scope: 'stage', limit: 1, includePreview: false } })))
  })

  it('keeps protocol binding and one-time ticket checks on the shared route', async () => {
    const app = await fixture()
    await app.login()
    const url = await app.ticketUrl()
    const mismatch = new URL(url)
    mismatch.searchParams.set('instanceId', 'obsolete-instance')
    expect(await app.reject(mismatch)).toBe(401)
    expect(await app.reject(url, 'http://another.example')).toBe(401)
    // A rejected Origin must not turn a fresh ticket into a successful socket.
    const fresh = await app.ticketUrl()
    const ws = app.socket(fresh)
    await once(ws, 'open')
    expect(await app.read(ws)).toMatchObject({ success: true })
    expect(await app.reject(fresh)).toBe(401)
  })

  it('refuses missing tickets, unregistered paths and the wrong public prefix', async () => {
    const app = await fixture('/nyxus')
    await app.login()
    const url = await app.ticketUrl()
    const anonymous = new URL(url)
    anonymous.search = ''
    expect(await app.reject(anonymous)).toBe(401)
    for (const pathname of ['/ws', '/nyxus/ws/extra', '/nyxus/unknown']) {
      const wrong = new URL(url)
      wrong.pathname = pathname
      expect(await app.reject(wrong)).toBe(0)
    }
    expect(app.reads).toEqual([])
  })

  it('closes upgraded sockets on logout and does not relax business parameter validation', async () => {
    const app = await fixture()
    const session = await app.login()
    const ws = app.socket(await app.ticketUrl())
    await once(ws, 'open')
    expect(await app.read(ws, {})).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } })
    expect(app.reads).toEqual([])
    const closed = once(ws, 'close')
    expect((await app.request('/api/browser-session', 'DELETE', { expectedRevision: session.revision, operationId: randomUUID() })).status).toBe(204)
    expect((await closed)[0]).toBe(4003)
    expect((await app.request('/api/browser-session')).status).toBe(401)
  })

  it('does not open the same-origin business route on a remote-only HTTP listener', async () => {
    const app = await fixture()
    await app.login()
    const url = await app.ticketUrl()
    const remote = createHttpServer({ webPort: 0, host: '127.0.0.1', auth: app.auth, listener: 'remote', webSocketServer: app.wss })
    await once(remote, 'listening')
    cleanups.push(() => new Promise<void>(resolve => remote.close(() => resolve())))
    url.port = String((remote.address() as { port: number }).port)
    expect(await app.reject(url)).toBe(0)
    expect(app.reads).toEqual([])
  })
})
