import { createServer, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { BackendMaintenance } from '../src/backendMaintenance.js'
import { relayReachable } from '../src/boundedHttp.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function server(handler: RequestListener) {
  const service = createServer(handler)
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => service.close(() => resolve())))
  return `http://127.0.0.1:${(service.address() as { port: number }).port}`
}
function client(target: string, timeoutMs = 1_000) {
  const value = new BackendMaintenance({ target: async () => target, credentials: async () => ({ username: 'synthetic-machine', password: 'synthetic-password', consistent: true }), timeoutMs })
  cleanup.push(() => value.close())
  return value
}
const discovery = { protocolVersion: 1, instanceId: 'machine-instance', protocolRange: { min: 1, max: 1 }, operations: ['relay.binding', 'relay.operation'], listener: 'local' }

describe('restricted maintenance HTTP', () => {
  it('discovers and calls only fixed authenticated routes, without browser credentials', async () => {
    const seen: Array<{ path?: string; headers: Record<string, unknown>; body: string }> = []
    const base = await server((req, res) => { void (async () => {
      let body = ''; for await (const chunk of req) body += chunk
      seen.push({ path: req.url, headers: req.headers, body })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(req.url === '/api/machine/login' ? { accessToken: 'synthetic-token' } : req.url === '/api/machine/capabilities' ? discovery : req.url === '/api/machine/relay/binding' ? { request: { requestId: 'r'.repeat(32) } } : { authorizations: [] }))
    })() })
    const c = client(base)
    expect(c.snapshot()).toEqual({ status: 'not_checked' })
    expect(seen).toEqual([])
    expect(await c.call(false, { type: 'authorization.list' })).toEqual({ authorizations: [] })
    expect(c.snapshot()).toMatchObject({ status: 'ready', instanceId: 'machine-instance' })
    expect(await c.call(true)).toHaveProperty('request.requestId')
    expect(seen.map(v => v.path)).toEqual(['/api/machine/login', '/api/machine/capabilities', '/api/machine/relay/operation', '/api/machine/login', '/api/machine/capabilities', '/api/machine/relay/binding'])
    for (const value of seen) {
      expect(value.headers).not.toHaveProperty('cookie'); expect(value.headers).not.toHaveProperty('origin')
      expect(value.headers).not.toHaveProperty('x-chery-relay-admin-token')
      if (value.path !== '/api/machine/login') expect(value.headers.authorization).toBe('Bearer synthetic-token')
    }
    expect(JSON.parse(seen[2]!.body)).toEqual({ type: 'authorization.list', input: {} })
  })
  it('rejects browser-selected destinations, methods and extra operation fields before requests', async () => {
    let hits = 0
    const c = client(await server((_req, res) => { hits++; res.end('{}') }))
    for (const input of [{ type: 'arbitrary' }, { type: 'policy.get', target: 'https://forbidden.example' }, { type: 'policy.get', input: { secret: true } }])
      await expect(c.call(false, input)).rejects.toMatchObject({ status: 400, code: 'invalid_params' })
    expect(hits).toBe(0)
    expect(c.snapshot().status).toBe('not_checked')
  })
  it.each([401, 403, 429, 404, 405])('classifies login status %i independently of Manager login', async status => {
    const c = client(await server((req, res) => { req.resume(); res.writeHead(status).end('private upstream text') }))
    await expect(c.call(false, { type: 'policy.get' })).rejects.toMatchObject({ code: [401, 403, 429].includes(status) ? 'backend_auth_failed' : 'backend_version_unsupported' })
    expect(JSON.stringify(c.snapshot())).not.toContain('private upstream text')
  })
  it('treats malformed discovery as unsupported, not as a missing Manager session', async () => {
    const c = client(await server((req, res) => { req.resume(); res.end(req.url === '/api/machine/login' ? '{"accessToken":"synthetic"}' : 'invalid JSON') }))
    await expect(c.call(false, { type: 'policy.get' })).rejects.toMatchObject({ status: 503, code: 'backend_version_unsupported' })
  })
  it('does not follow authenticated redirects or send tokens to a second destination', async () => {
    let hits = 0
    const destination = await server((_req, res) => { hits++; res.end('{}') })
    const c = client(await server((req, res) => { req.resume(); res.writeHead(302, { Location: destination }).end() }))
    await expect(c.call(false, { type: 'policy.get' })).rejects.toMatchObject({ status: 503 })
    expect(hits).toBe(0)
  })
  it('records an ambiguous write without retrying it', async () => {
    let writes = 0
    const c = client(await server((req, res) => {
      req.resume()
      if (req.url === '/api/machine/login') res.end('{"accessToken":"synthetic"}')
      else if (req.url === '/api/machine/capabilities') res.end(JSON.stringify(discovery))
      else { writes++; req.socket.destroy() }
    }))
    await expect(c.call(false, { type: 'policy.set', input: { publicDiscovery: true, remotePasswordEnabled: true } })).rejects.toMatchObject({ status: 502, code: 'save_unconfirmed' })
    expect(writes).toBe(1)
    expect(c.snapshot().status).toBe('unavailable')
  })
  it('bounds response size and total wait', async () => {
    const large = client(await server((req, res) => { req.resume(); res.end('x'.repeat(70_000)) }))
    await expect(large.call(false, { type: 'policy.get' })).rejects.toMatchObject({ status: 503 })
    const stalled = client(await server(req => { req.resume() }), 30)
    await expect(stalled.call(false, { type: 'policy.get' })).rejects.toMatchObject({ status: 503 })
  })
  it('health checks reject oversized bodies and credential-bearing URLs', async () => {
    const base = await server((_req, res) => res.end('x'.repeat(70_000)))
    expect(await relayReachable(base)).toBe(false)
    expect(await relayReachable(base.replace('http://', 'http://private:password@'))).toBe(false)
  })
})
