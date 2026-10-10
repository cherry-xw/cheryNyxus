import { describe, expect, it, vi } from 'vitest'
import { WebSearchRuntime, type SearchResult } from '@/agent/sense/web/runtime.js'
import { createWebSearchSense } from '@/agent/sense/webSearch.js'
import type { CacheTelemetry } from '@/core/sense/runtimeCache.js'

const item = { title: 'Fixture', url: 'https://example.test/?b=2&a=1', snippet: 'local only' }

function fixture(maxBytes = 10000) {
  let now = 0
  const events: CacheTelemetry[] = []
  const search = vi.fn(async (): Promise<SearchResult[]> => [item])
  const runtime = new WebSearchRuntime({
    timeoutMs: 10,
    cache: { ttlMs: 100, maxEntries: 2, maxBytes, now: () => now, onLookup: (e) => events.push(e) },
  })
  runtime.register({ id: 'fixture', availability: () => 'ready', search })
  const sense = createWebSearchSense(runtime)
  const call = async (query: string, signal?: AbortSignal) => {
    const result = await sense.executor.execute({ query }, new Map(), {
      chatId: 'cache-test',
      signal,
    })
    expect(result.hash).toBeUndefined()
    return JSON.parse(result.content)
  }
  return {
    runtime,
    search,
    events,
    call,
    tick: (value: number) => {
      now = value
    },
  }
}

describe('web_search production cache consumer', () => {
  it('uses canonical defaults, hit/miss/stale and LRU eviction through the Sense', async () => {
    const f = fixture()
    const first = await f.call('  alpha  ')
    f.tick(1)
    expect(await f.call('alpha')).toEqual(first)
    expect(f.search).toHaveBeenCalledTimes(1)
    expect(f.events.map((e) => e.status)).toEqual(['miss', 'hit'])
    f.tick(2)
    await f.call('beta')
    f.tick(3)
    await f.call('alpha')
    f.tick(4)
    await f.call('gamma')
    f.tick(5)
    await f.call('beta')
    expect(f.events.at(-1)?.status).toBe('miss')
    expect(f.search).toHaveBeenCalledTimes(4)
    f.tick(105)
    await f.call('beta')
    expect(f.events.at(-1)?.status).toBe('stale')
    expect(f.search).toHaveBeenCalledTimes(5)
    expect(f.events.every((e) => /^[a-f0-9]{64}$/.test(e.key))).toBe(true)
    expect(JSON.stringify(f.events)).not.toContain('alpha')
  })

  it('separates provider, output budget and limit, and bounds stored bytes', async () => {
    const f = fixture()
    await f.call('alpha')
    await f.runtime.search({ query: 'alpha', limit: 5, max_output_chars: 8000 })
    expect(f.search).toHaveBeenCalledTimes(1)
    await f.runtime.search({ query: 'alpha', limit: 1 })
    await f.runtime.search({ query: 'alpha', max_output_chars: 512 })
    expect(f.search).toHaveBeenCalledTimes(3)
    const small = fixture(1)
    await small.call('alpha')
    await small.call('alpha')
    expect(small.search).toHaveBeenCalledTimes(2)
    let selected = 'one'
    const runtime = new WebSearchRuntime({ provider: () => selected })
    for (const id of ['one', 'two'])
      runtime.register({ id, availability: () => 'ready', search: f.search })
    await runtime.search({ query: 'alpha' })
    selected = 'two'
    expect((await runtime.search({ query: 'alpha' })).provider).toBe('two')
    expect(f.search).toHaveBeenCalledTimes(5)
  })

  it('dedupes canonical URLs, preserves partial observations and isolates returned values', async () => {
    const f = fixture()
    f.search.mockResolvedValue([
      item,
      { ...item, url: 'https://example.test/?a=1&b=2#section' },
      { ...item, url: 'javascript:bad' },
    ])
    const original = await f.call('partial')
    expect(original.results).toHaveLength(1)
    expect(original.truncated).toBe(true)
    const recovered = await f.runtime.search({ query: 'partial' }, undefined, 'replay')
    expect(recovered).toEqual(original)
    recovered.results[0]!.title = 'mutated'
    expect(await f.call('partial')).toEqual(original)
    expect(f.search).toHaveBeenCalledTimes(1)
  })

  it('never executes a provider during replay, including expired, missing and restarted state', async () => {
    const f = fixture()
    expect((await f.runtime.search({ query: 'missing' }, undefined, 'replay')).error?.code).toBe(
      'recovery_unavailable',
    )
    expect(f.search).not.toHaveBeenCalled()
    await f.call('alpha')
    f.tick(100)
    expect((await f.runtime.search({ query: 'alpha' }, undefined, 'replay')).error?.code).toBe(
      'recovery_unavailable',
    )
    expect(f.search).toHaveBeenCalledTimes(1)
    const restarted = fixture()
    expect(
      (await restarted.runtime.search({ query: 'alpha' }, undefined, 'replay')).error?.code,
    ).toBe('recovery_unavailable')
    expect(restarted.search).not.toHaveBeenCalled()
    await restarted.call('alpha')
    expect(restarted.search).toHaveBeenCalledTimes(1)
  })

  it('does not cache failures or silently retry and leaves unrelated successes intact', async () => {
    const f = fixture()
    const saved = await f.call('saved')
    f.search.mockRejectedValueOnce(new Error('private provider detail'))
    expect((await f.call('failed')).error.code).toBe('network_error')
    expect((await f.runtime.search({ query: 'failed' }, undefined, 'replay')).error?.code).toBe(
      'recovery_unavailable',
    )
    expect(f.search).toHaveBeenCalledTimes(2)
    expect(await f.call('saved')).toEqual(saved)
    expect((await f.call('failed')).ok).toBe(true)
    expect(f.search).toHaveBeenCalledTimes(3)
  })

  it.each(['cancel', 'timeout'] as const)(
    'discards late %s results and recovers only on a new call',
    async (mode) => {
      const f = fixture()
      let finish!: (value: SearchResult[]) => void
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      f.search.mockImplementationOnce(() => {
        entered()
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const controller = new AbortController()
      const pending = f.call('late', controller.signal)
      await started
      if (mode === 'cancel') controller.abort()
      expect((await pending).error.code).toBe(mode === 'cancel' ? 'cancelled' : 'timeout')
      finish([item])
      await Promise.resolve()
      expect((await f.runtime.search({ query: 'late' }, undefined, 'replay')).error?.code).toBe(
        'recovery_unavailable',
      )
      expect(f.search).toHaveBeenCalledTimes(1)
      expect((await f.call('late')).ok).toBe(true)
      expect(f.search).toHaveBeenCalledTimes(2)
      controller.abort()
      expect((await f.call('late', controller.signal)).error.code).toBe('cancelled')
      expect(f.search).toHaveBeenCalledTimes(2)
    },
  )
})
