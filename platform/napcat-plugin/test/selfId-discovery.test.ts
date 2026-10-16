import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Adapter, type PluginContext } from '../src/adapter.js'
import { QQCapabilities as capabilities } from '@chery/protocol'
import type { BackendChannel } from '../src/wire.js'

// Fully synthetic fixtures: no real NapCat socket, no backend service, no QQ traffic, no real credentials.
class Mock implements BackendChannel {
  connected = true
  selfId = '123'
  listener?: (f: any) => void
  ready?: () => void
  disconnect?: () => void
  request = vi.fn(async (method: string, params: any): Promise<any> => {
    const data = method === 'qq.plugin.hello' ? { protocolVersion: 1, backendVersion: 'mock', selfId: this.selfId, authenticated: true, capabilities }
      : method === 'qq.identity.bind' ? { bound: true, selfId: params.selfId, sourceType: 'napcat-action', validation: 'accepted' }
      : method === 'qq.request.recover' ? { events: [] }
      : method === 'qq.event.submit' ? { eventId: params.eventId, accepted: true } : { eventId: params.eventId, recorded: true }
    return { success: true, data }
  })
  connect = vi.fn(async () => {})
  close = vi.fn(() => { this.listener = undefined })
  onMessage(f: (v: any) => void) { this.listener = f; return () => { this.listener = undefined } }
}

type Identity = { state: string; sourceType: string; validation: string; diagnostic: string }
const identityOf = (adapter: Adapter): Identity => adapter.status().identity as Identity
const DISCOVERED: Identity = { state: 'discovered', sourceType: 'napcat-action', validation: 'accepted', diagnostic: 'none' }
const REFUSED = (sourceType: string, diagnostic: string): Identity => ({ state: 'unavailable', sourceType, validation: 'rejected', diagnostic })
/** Structured outputs and diagnostics must stay sanitised: no secrets and no raw Action response bodies. */
const assertNoIdentityLeak = (value: unknown) => {
  const text = JSON.stringify(value) ?? ''
  expect(text).not.toMatch(/token|secret|credential|password|cookie/i)
  expect(text).not.toContain('login_info_response')
  expect(text).not.toContain('status_response')
}

const live: Adapter[] = []
const dirs: string[] = []
afterEach(() => { for (const a of live.splice(0)) a.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture(actions: (name: string) => unknown, dir = mkdtempSync('/tmp/opencode/native-qq-selfid-'), timeout?: number) {
  dirs.push(dir)
  const ctx: PluginContext = { dataPath: dir, configPath: join(dir, 'config.json'), adapterName: 'test', pluginManager: { config: { test: true } }, logger: { info: vi.fn(), warn: vi.fn() }, actions: { call: vi.fn(async (name: string) => actions(name)) } }
  const wire = new Mock(); const adapter = new Adapter(ctx, wire, timeout); live.push(adapter)
  return { dir, ctx, wire, adapter }
}
const input = (extra = {}) => ({ post_type: 'message', self_id: 123, user_id: 789, group_id: 456, message_type: 'group', message_id: -42, time: 10, sender: { user_id: 789, nickname: 'synthetic' }, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'at', data: { qq: '123' } }], ...extra })

describe('selfId discovery trust boundaries (synthetic fixtures only, no real NapCat/backend/QQ)', () => {
  it('discovers identity only from trusted restricted Actions with the exact structured fields', async () => {
    const { adapter, wire, ctx } = fixture(name => name === 'get_login_info' ? { user_id: '123' } : name === 'get_status' ? { online: true, good: true, marker: 'status_response' } : { message_id: '1' })
    await adapter.start(); await settle()
    expect(adapter.status()).toMatchObject({ state: 'ready', ready: true })
    expect(identityOf(adapter)).toEqual(DISCOVERED)
    const calls = (ctx.actions.call as any).mock.calls
    expect(calls.map((c: any) => c[0]).slice(0, 2)).toEqual(['get_login_info', 'get_status'])
    expect(calls.every((c: any) => c[2] === ctx.adapterName && c[3] === ctx.pluginManager.config)).toBe(true)
    expect(wire.connect).toHaveBeenCalledTimes(1)
    expect(wire.request.mock.calls[0]![0]).toBe('qq.plugin.hello')
    expect(wire.request.mock.calls[0]![1]).toMatchObject({ protocolVersion: 1, pluginVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/), selfId: '123' })
    assertNoIdentityLeak(adapter.status())
    assertNoIdentityLeak((ctx.logger.warn as any).mock.calls)
  })

  it('applies the stable failure matrix: malformed selfId and offline status all refuse to continue', async () => {
    for (const [login, status, diagnostic] of [
      [{}, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: 0 }, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: -5 }, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: '-5' }, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: '00123' }, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: ' 123 ' }, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: 1.5 }, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: Number.MAX_SAFE_INTEGER + 1 }, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: '123' }, { online: true, good: false }, 'offline'],
      [{ user_id: '123' }, { online: false, good: true }, 'offline'],
      [{ user_id: '123' }, { online: true }, 'offline'],
    ] as const) {
      const { adapter, wire, ctx } = fixture(name => name === 'get_login_info' ? login : name === 'get_status' ? status : { message_id: '1' })
      await adapter.start(); await settle()
      expect(adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false })
      expect(identityOf(adapter)).toEqual(REFUSED('napcat-action', diagnostic))
      expect(wire.connect).not.toHaveBeenCalled()
      expect(wire.request).not.toHaveBeenCalled()
      expect(ctx.logger.warn).toHaveBeenCalledWith('cheryNyxus: identity-unavailable')
      assertNoIdentityLeak(adapter.status()); assertNoIdentityLeak((ctx.logger.warn as any).mock.calls)
    }
  })

  it('refuses identity that only exists in hello traffic or backend responses', async () => {
    // get_login_info/get_status return unusable bodies: no trusted source exists, so nothing from hello may be trusted either.
    const helloOnly = fixture(name => name === 'get_login_info' ? { marker: 'login_info_response' } : { marker: 'status_response' })
    await helloOnly.adapter.start(); await settle()
    expect(helloOnly.wire.connect).not.toHaveBeenCalled()
    expect(helloOnly.wire.request).not.toHaveBeenCalled()
    expect(identityOf(helloOnly.adapter)).toEqual(REFUSED('napcat-action', 'invalid-self-id'))
    expect(helloOnly.adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false })

    // A hostile backend answering hello with an authenticated selfId cannot mint identity when Actions never succeeded.
    const hostile = fixture(() => { throw new Error('actions unavailable') })
    hostile.wire.request.mockImplementation(async (method: string) => {
      if (method === 'qq.plugin.hello') return { protocolVersion: 1, backendVersion: 'hostile', selfId: '999', authenticated: true, capabilities }
      throw new Error('channel must not be used before identity discovery')
    })
    await hostile.adapter.start(); await settle()
    expect(hostile.wire.connect).not.toHaveBeenCalled()
    expect(hostile.wire.request).not.toHaveBeenCalled()
    expect(identityOf(hostile.adapter)).toEqual(REFUSED('none', 'action-error'))
    expect(hostile.adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false })

    // hello with authenticated=false fails channel auth: discovery stands, but the adapter never becomes ready or consumes events.
    const unauth = fixture(name => name === 'get_login_info' ? { user_id: '123' } : { online: true, good: true })
    unauth.wire.request.mockImplementation(async (method: string) => method === 'qq.plugin.hello'
      ? { protocolVersion: 1, backendVersion: 'mock', selfId: '123', authenticated: false, capabilities }
      : { events: [] })
    await unauth.adapter.start(); await settle()
    expect(identityOf(unauth.adapter)).toEqual(DISCOVERED)
    expect(unauth.adapter.status()).toMatchObject({ state: 'backend-unsupported', ready: false })
    await unauth.adapter.receive(input()); await settle()
    expect(unauth.wire.request.mock.calls.filter(c => c[0] === 'qq.event.submit')).toHaveLength(0)
    expect(unauth.wire.request.mock.calls.map(c => c[0])).toEqual(['qq.plugin.hello'])
    assertNoIdentityLeak(unauth.adapter.status())
  })

  it('never treats ordinary logs as identity evidence', async () => {
    const { adapter, wire, ctx } = fixture(() => { throw new Error('actions unavailable') })
    for (const line of ['登录成功，账号 123 已上线', '扫码确认完成 self_id: 123', '插件加载成功 v0.1.0, self_id=123 online']) ctx.logger.info?.(line)
    await adapter.start(); await settle()
    expect(identityOf(adapter)).toEqual(REFUSED('none', 'action-error'))
    expect(adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false })
    expect(wire.connect).not.toHaveBeenCalled()
    expect(wire.request).not.toHaveBeenCalled()
  })

  it('a failed new discovery cannot reuse the identity from the previous connection', async () => {
    const { adapter, wire, ctx } = fixture(name => name === 'get_login_info' ? { user_id: '123' } : { online: true, good: true })
    await adapter.start()
    expect(adapter.status().ready).toBe(true)
    ;(ctx.actions.call as any).mockResolvedValue({})
    await adapter.start()
    expect(adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false,
      identity: REFUSED('napcat-action', 'invalid-self-id') })
    expect(wire.request.mock.calls.filter(([method]) => method === 'qq.plugin.hello')).toHaveLength(1)
  })

  it('starts fail-closed on missing sources and refuses Action exceptions and timeouts', async () => {
    const missing = fixture(() => { throw new Error('missing action') })
    expect(identityOf(missing.adapter)).toEqual(REFUSED('none', 'source-missing'))
    await missing.adapter.start(); await settle()
    expect(missing.adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false })
    expect(identityOf(missing.adapter)).toEqual(REFUSED('none', 'action-error'))
    expect(missing.wire.connect).not.toHaveBeenCalled()

    const failing = fixture(() => { throw new Error('boom: token=abc123') })
    await failing.adapter.start(); await settle()
    expect(failing.adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false })
    expect(identityOf(failing.adapter)).toEqual(REFUSED('none', 'action-error'))
    expect(failing.wire.connect).not.toHaveBeenCalled()
    expect(failing.ctx.logger.warn).toHaveBeenCalledWith('cheryNyxus: identity-unavailable')
    assertNoIdentityLeak(failing.adapter.status()); assertNoIdentityLeak((failing.ctx.logger.warn as any).mock.calls)

    vi.useFakeTimers()
    const slow = fixture(() => new Promise(() => {}), undefined, 10)
    void slow.adapter.start()
    await vi.advanceTimersByTimeAsync(11); await settle()
    expect(slow.adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false })
    expect(slow.wire.connect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    assertNoIdentityLeak(slow.adapter.status())
  })

  it('keeps refusing to continue when trusted sources disagree on selfId', async () => {
    // Trusted Action identity vs a conflicting backend hello response.
    const mismatch = fixture(name => name === 'get_login_info' ? { user_id: '123' } : { online: true, good: true })
    mismatch.wire.request.mockImplementation(async (method: string) => method === 'qq.plugin.hello'
      ? { protocolVersion: 1, backendVersion: 'mock', selfId: '999', authenticated: true, capabilities }
      : { events: [] })
    await mismatch.adapter.start(); await settle()
    expect(identityOf(mismatch.adapter)).toEqual(DISCOVERED)
    expect(mismatch.adapter.status()).toMatchObject({ state: 'backend-unsupported', ready: false })
    expect(mismatch.wire.request.mock.calls.map(c => c[0])).toEqual(['qq.plugin.hello'])
    // A connection self-reported selfId cannot override the discovered one either.
    await mismatch.adapter.receive(input({ self_id: 999 })); await settle()
    expect(mismatch.wire.request.mock.calls.filter(c => c[0] === 'qq.event.submit')).toHaveLength(0)
    expect(identityOf(mismatch.adapter)).toEqual(DISCOVERED)

    // Stale persisted records (an old delivery journal selfId) never outrank the trusted Action source.
    const staleDir = mkdtempSync('/tmp/opencode/native-qq-selfid-')
    writeFileSync(join(staleDir, 'delivery-journal.json'), JSON.stringify({
      events: {}, seq: {}, blocked: {},
      outputs: { old: { hash: 'ab'.repeat(32), status: 'sent', confirmation: { eventId: 'old', requestId: 'old', selfId: '777', conversationType: 'group', targetId: '456', status: 'sent', messageIds: ['1'], seq: 1, activity: false, terminal: true, sentAt: 1 } } },
    }))
    const stale = fixture(name => name === 'get_login_info' ? { user_id: '123' } : { online: true, good: true }, staleDir)
    await stale.adapter.start(); await settle()
    expect(stale.adapter.status()).toMatchObject({ state: 'ready', ready: true })
    expect(identityOf(stale.adapter)).toEqual(DISCOVERED)
    const hello = stale.wire.request.mock.calls.find(c => c[0] === 'qq.plugin.hello')![1] as any
    expect(hello.selfId).toBe('123')
    assertNoIdentityLeak(stale.adapter.status())
  })
})
