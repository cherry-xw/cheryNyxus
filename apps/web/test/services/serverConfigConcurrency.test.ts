import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureServiceAuth } from '../../src/services/authContext'
import { clearCapabilities, currentCapabilities } from '../../src/services/platform'
import { clearServerConfigCache, fetchServerConfig } from '../../src/services/agentApiTransport'

vi.mock('../../src/services/ws', () => ({ wsClient: { rpc: vi.fn() } }))

const snapshot = (id: string) => ({ protocolVersion: 1, instanceId: id, revision: id, preset: 'basic',
  capabilities: ['chat.core', 'interaction.respond', 'timeline.read'],
  protocolRanges: { relay: { min: 2, max: 2 }, websocket: { min: 1, max: 1 } } })
const response = (id: string) => new Response(JSON.stringify({ bootstrap: snapshot(id), senseGroups: [{ name: id }] }))
let context: string
let base: string
const ticket = vi.fn(async () => ({ ticket: 't'.repeat(32), wsPath: '/ws' }))
const port = () => ({ isRemote: () => false, baseUrl: () => base, accessToken: () => '', headers: () => ({}),
  contextKey: () => context, refresh: async () => false, ticket })
beforeEach(() => {
  clearServerConfigCache(); clearCapabilities(); vi.clearAllMocks()
  context = 'A:1'; base = ''; configureServiceAuth(port())
})
afterEach(() => { clearServerConfigCache(); clearCapabilities(); vi.unstubAllGlobals() })

describe('configuration reads for concurrent workbench initialization', () => {
  it('shares one pending read and one ticket, then caches the successful config', async () => {
    let finish!: (value: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetch)
    const first = fetchServerConfig(), second = fetchServerConfig(), third = fetchServerConfig()
    expect(fetch).toHaveBeenCalledTimes(1)
    finish(response('current'))
    const values = await Promise.all([first, second, third])
    expect(values[0]).toBe(values[1]); expect(values[0]).toBe(values[2])
    expect(values[0]?.senseGroups).toEqual([{ name: 'current' }])
    expect(ticket).toHaveBeenCalledTimes(1)
    expect(await fetchServerConfig()).toBe(values[0])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shares failure but allows a later explicit retry rather than caching an empty config', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response('retry'))
    vi.stubGlobal('fetch', fetch)
    const results = await Promise.allSettled([fetchServerConfig(), fetchServerConfig()])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await fetchServerConfig()).bootstrap?.instanceId).toBe('retry')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('clearing pending config rejects its late response without clearing the new cached read', async () => {
    const finishes: Array<(value: Response) => void> = []
    const fetch = vi.fn(() => new Promise<Response>(resolve => finishes.push(resolve)))
    vi.stubGlobal('fetch', fetch)
    const old = fetchServerConfig(), rejected = expect(old).rejects.toThrow(/过期|旧配置/)
    clearServerConfigCache()
    const fresh = fetchServerConfig()
    finishes[1]!(response('new')); const value = await fresh
    finishes[0]!(response('old')); await rejected
    expect(await fetchServerConfig()).toBe(value)
    expect(currentCapabilities()?.instanceId).toBe('new')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('never reuses cached config across authentication ports, target addresses, or context revisions', async () => {
    const fetch = vi.fn(async () => response(context))
    vi.stubGlobal('fetch', fetch)
    await fetchServerConfig()
    configureServiceAuth(port()); await fetchServerConfig()
    base = 'http://backend.test'; await fetchServerConfig()
    context = 'B:2'; await fetchServerConfig()
    context = 'A:3'; expect((await fetchServerConfig()).bootstrap?.instanceId).toBe('A:3')
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('disconnect still invalidates a pending shared response', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = fetchServerConfig(), rejected = expect(pending).rejects.toThrow('过期')
    clearCapabilities(); finish(response('old')); await rejected
    expect(currentCapabilities()).toBeUndefined()
  })
})
