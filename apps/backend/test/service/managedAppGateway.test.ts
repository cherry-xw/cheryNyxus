import { describe, it, expect, vi } from 'vitest'
import { createManagedAppGateway, parseAppRoute, forwardHeaders } from '../../src/service/managedApp/gateway.ts'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControllerSocketClient } from '../../src/service/managedApp/socketRpc.ts'
function response() {
  return { writeHead: vi.fn(), end: vi.fn(), once: vi.fn() } as unknown as ServerResponse
}
describe('managed app gateway', () => {
  it('parses exact owner and app paths without traversals', () => {
    expect(parseAppRoute('/qq/649207438/apps/demo/api/items?x=1')?.suffix).toBe('/api/items?x=1')
    expect(parseAppRoute('/qq/649207438/apps/demo')?.redirect).toBe(true)
    for (const path of ['../secret', '%2e%2e/secret', '%252e%252e/secret', '%zz', 'a\\b', 'a//b']) expect(parseAppRoute(`/qq/649207438/apps/demo/${path}`)).toBeUndefined()
  })
  it('strips platform secrets and spoofed forwarding metadata, preserving only this app cookie', () => {
    const route = parseAppRoute('/qq/649207438/apps/demo/')!
    const headers = forwardHeaders({ headers: { authorization: 'test-platform-token', cookie: 'chery_business_session=test; chery_app_sid_demo=app; chery_app_sid_other=other', 'x-chery-owner-id': 'forged', 'x-forwarded-user': 'forged', connection: 'keep-alive, x-secret', 'x-secret': 'hidden' } } as unknown as IncomingMessage, route)
    expect(headers.cookie).toBe(' chery_app_sid_demo=app')
    expect(headers['x-chery-owner-id']).toBe('649207438')
    expect(headers).not.toHaveProperty('authorization')
    expect(headers).not.toHaveProperty('x-secret')
    expect(headers).not.toHaveProperty('x-forwarded-user')
  })
  it('does not intercept share or ordinary backend routes', async () => {
    const gateway = createManagedAppGateway({} as ControllerSocketClient)
    expect(await gateway.handle({ url: '/qq/649207438/share/a.txt' } as IncomingMessage, response())).toBe(false)
    expect(await gateway.handle({ url: '/api/config' } as IncomingMessage, response())).toBe(false)
  })
  it('never exposes internal health or activation secrets', async () => {
    const inspectAppStatus = vi.fn()
    const gateway = createManagedAppGateway({ inspectAppStatus } as unknown as ControllerSocketClient)
    const res = response()
    await gateway.handle({ url: '/qq/649207438/apps/demo/%5f%5fapp_health', headers: {} } as IncomingMessage, res)
    expect(res.writeHead).toHaveBeenCalledWith(404)
    expect(inspectAppStatus).not.toHaveBeenCalled()
  })
  it('does not publish a running but unready work container', async () => {
    const gateway = createManagedAppGateway({ inspectAppStatus: async () => [{ userId: '649207438', appId: 'demo', state: 'running', serviceReady: false, containerIp: '172.29.0.3' }] } as unknown as ControllerSocketClient)
    const res = response()
    await gateway.handle({ url: '/qq/649207438/apps/demo/api/items', headers: { accept: 'application/json' } } as IncomingMessage, res)
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object))
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('APP_STOPPED'))
  })
  it('rejects connections beyond the per-app limit before querying the controller', async () => {
    const inspectAppStatus = vi.fn(async () => [])
    const gateway = createManagedAppGateway({ inspectAppStatus } as unknown as ControllerSocketClient)
    for (let i = 0; i < 32; i++) await gateway.handle({ url: '/qq/649207438/apps/demo/', headers: {} } as IncomingMessage, response())
    const res = response()
    await gateway.handle({ url: '/qq/649207438/apps/demo/', headers: {} } as IncomingMessage, res)
    expect(res.writeHead).toHaveBeenCalledWith(429)
    expect(inspectAppStatus).toHaveBeenCalledTimes(32)
  })
  it('releases capacity exactly once and drains held connections', async () => {
    const gateway = createManagedAppGateway({ inspectAppStatus: async () => [] } as unknown as ControllerSocketClient)
    const held: ServerResponse[] = []
    for (let i = 0; i < 32; i++) {
      const stream = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn() }) as unknown as ServerResponse
      held.push(stream)
      await gateway.handle({ url: '/qq/649207438/apps/demo/', headers: {} } as IncomingMessage, stream)
    }
    held[0]!.emit('finish'); held[0]!.emit('close')
    const replacement = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn(), destroy: vi.fn() }) as unknown as ServerResponse
    await gateway.handle({ url: '/qq/649207438/apps/demo/', headers: {} } as IncomingMessage, replacement)
    expect(replacement.writeHead).toHaveBeenCalledWith(503, expect.any(Object))
    gateway.drain()
    expect(replacement.destroy).toHaveBeenCalledOnce()
    expect(held[0]!.destroy).not.toHaveBeenCalled()
    const rejected = response()
    await gateway.handle({ url: '/qq/649207438/apps/demo/', headers: {} } as IncomingMessage, rejected)
    expect(rejected.writeHead).toHaveBeenCalledWith(429)
  })
  it('shows Chinese stopped page without waking the container', async () => {
    const gateway = createManagedAppGateway({ inspectAppStatus: async () => [] } as unknown as ControllerSocketClient)
    const res = response()
    await gateway.handle({ url: '/qq/649207438/apps/demo/', headers: { accept: 'text/html' } } as IncomingMessage, res)
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('应用当前不可用'))
  })
})
