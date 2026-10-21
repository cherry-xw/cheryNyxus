import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureServiceAuth } from '../../src/services/authContext'
import { clearCapabilities, currentCapabilities, getServerConfig } from '../../src/services/platform'
const snapshot = (id: string) => ({ protocolVersion: 1, instanceId: id, revision: id, preset: 'basic', capabilities: ['chat.core', 'interaction.respond', 'timeline.read'], protocolRanges: { relay: { min: 2, max: 2 }, websocket: { min: 1, max: 1 } } })
describe('F05 HTTP capability context isolation', () => {
  beforeEach(() => clearCapabilities())
  it('rejects A config arriving after target B and never publishes it', async () => {
    let context = 'A'; let finish!: (value: Response) => void
    configureServiceAuth({ isRemote: () => true, baseUrl: () => 'http://localhost', accessToken: () => '', headers: () => ({}), contextKey: () => context, refresh: async () => false })
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const pending = getServerConfig(); context = 'B'; finish(new Response(JSON.stringify({ bootstrap: snapshot('A') })))
    await expect(pending).rejects.toThrow('过期')
    expect(currentCapabilities()).toBeUndefined(); vi.unstubAllGlobals()
  })
  it('publishes only newest config in reversed completion order and A→B→A context revisions', async () => {
    let context = 'A:1'; const finishes: Array<(v: Response) => void> = []
    configureServiceAuth({ isRemote: () => true, baseUrl: () => 'http://localhost', accessToken: () => '', headers: () => ({}), contextKey: () => context, refresh: async () => false })
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => finishes.push(resolve))))
    const first = getServerConfig(); const rejection = expect(first).rejects.toThrow('过期')
    context = 'B:2'; const second = getServerConfig(); const secondRejection = expect(second).rejects.toThrow('过期')
    context = 'A:3'; const current = getServerConfig()
    finishes[2]!(new Response(JSON.stringify({ bootstrap: snapshot('A-new') }))); expect((await current).bootstrap?.instanceId).toBe('A-new')
    finishes[1]!(new Response(JSON.stringify({ bootstrap: snapshot('B') }))); finishes[0]!(new Response(JSON.stringify({ bootstrap: snapshot('A-old') })))
    await Promise.all([rejection, secondRejection]); expect(currentCapabilities()?.instanceId).toBe('A-new'); vi.unstubAllGlobals()
  })
  it('disconnect invalidates a pending config and selected protocols never depend on relay software', async () => {
    let finish!: (v: Response) => void
    configureServiceAuth({ isRemote: () => true, baseUrl: () => 'http://localhost', accessToken: () => '', headers: () => ({}), contextKey: () => 'A', refresh: async () => false })
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const pending = getServerConfig(); const rejected = expect(pending).rejects.toThrow('过期'); clearCapabilities(); finish(new Response(JSON.stringify({ bootstrap: snapshot('old') }))); await rejected; expect(currentCapabilities()).toBeUndefined(); vi.unstubAllGlobals()
  })
  it('F05 ticket completions reversed cannot overwrite newest instance', async () => {
    const tickets: Array<(v: { ticket: string; wsPath: string }) => void> = []; let instance = 'first'
    configureServiceAuth({ isRemote: () => true, baseUrl: () => 'http://localhost', accessToken: () => '', headers: () => ({}), contextKey: () => 'same-target', refresh: async () => false, ticket: () => new Promise((r) => tickets.push(r)) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ bootstrap: snapshot(instance) }))))
    const old = getServerConfig(), rejected = expect(old).rejects.toThrow('过期'); await vi.waitFor(() => expect(tickets).toHaveLength(1)); instance = 'second'; const fresh = getServerConfig(); await vi.waitFor(() => expect(tickets).toHaveLength(2))
    tickets[1]!({ ticket: 'n'.repeat(32), wsPath: '/ws' }); expect((await fresh).bootstrap?.instanceId).toBe('second'); tickets[0]!({ ticket: 'o'.repeat(32), wsPath: '/ws' }); await rejected; expect(currentCapabilities()?.instanceId).toBe('second'); vi.unstubAllGlobals()
  })
  it('rejects a late ticket and a well-formed range without intersection', async () => {
    let context = 'A'; let finish!: (value: { ticket: string; wsPath: string }) => void
    configureServiceAuth({ isRemote: () => true, baseUrl: () => 'http://localhost', accessToken: () => '', headers: () => ({}), contextKey: () => context, refresh: async () => false, ticket: () => new Promise((resolve) => { finish = resolve }) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ bootstrap: snapshot('A') }))))
    const pending = getServerConfig(); await vi.waitFor(() => expect(finish).toBeTypeOf('function')); context = 'B'; finish({ ticket: 'x'.repeat(32), wsPath: '/ws' })
    await expect(pending).rejects.toThrow('过期'); expect(currentCapabilities()).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ bootstrap: { ...snapshot('B'), protocolRanges: { relay: { min: 2, max: 2 }, websocket: { min: 2, max: 2 } } } }))))
    await expect(getServerConfig()).rejects.toThrow('交集'); expect(currentCapabilities()).toBeUndefined(); vi.unstubAllGlobals()
  })
})
