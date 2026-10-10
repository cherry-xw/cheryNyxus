import { describe, expect, it } from 'vitest'
import {
  BoundedRuntimeCache,
  canonicalCacheKey,
  createObservationDedupe,
} from '@/core/sense/runtimeCache.js'

describe('Sense runtime cache and observation dedupe', () => {
  it('canonicalizes query order and excludes URL secrets', () => {
    const a = canonicalCacheKey({
      operationClass: 'web-fetch',
      url: 'https://example.test/page?b=2&a=1&token=one#section',
      provider: 'fixture',
    })
    const b = canonicalCacheKey({
      operationClass: 'web-fetch',
      url: 'https://example.test/page?a=1&b=2&token=two',
      provider: 'fixture',
    })
    expect(a).toBe(b)
  })

  it('only redacts sensitive field names at word boundaries', () => {
    const keywordA = canonicalCacheKey({
      operationClass: 'web-search',
      query: { keyword: 'a' },
    })
    const keywordB = canonicalCacheKey({
      operationClass: 'web-search',
      query: { keyword: 'b' },
    })
    expect(keywordA).not.toBe(keywordB)

    expect(
      canonicalCacheKey({
        operationClass: 'fixture',
        query: { apiKey: 'one', hotkey: 'a' },
      }),
    ).toBe(
      canonicalCacheKey({
        operationClass: 'fixture',
        query: { apiKey: 'two', hotkey: 'a' },
      }),
    )
    expect(
      canonicalCacheKey({
        operationClass: 'fixture',
        query: { hotkey: 'a' },
      }),
    ).not.toBe(
      canonicalCacheKey({
        operationClass: 'fixture',
        query: { hotkey: 'b' },
      }),
    )
  })

  it('reports miss, hit, stale and enforces entry/byte bounds', () => {
    let now = 0
    const cache = new BoundedRuntimeCache<string>({
      ttlMs: 100,
      maxEntries: 2,
      maxBytes: 8,
      now: () => now,
    })
    expect(cache.get('missing').status).toBe('miss')
    expect(cache.set('a', '1234')).toBe(true)
    expect(cache.get('a')).toEqual({ status: 'hit', value: '1234' })
    now = 101
    expect(cache.get('a').status).toBe('stale')
    expect(cache.set('too-large', '123456789')).toBe(false)
    expect(cache.size).toBe(0)
  })

  it('evicts the least recently used entry and dedupes only within one observation', () => {
    let now = 0
    const cache = new BoundedRuntimeCache<string>({
      ttlMs: 1000,
      maxEntries: 2,
      maxBytes: 100,
      now: () => now++,
    })
    cache.set('a', 'a')
    cache.set('b', 'b')
    cache.get('a')
    cache.set('c', 'c')
    expect(cache.get('b').status).toBe('miss')
    expect(cache.get('a').status).toBe('hit')

    const dedupe = createObservationDedupe()
    expect(dedupe.urlSeen('https://example.test/#one')).toBe(false)
    expect(dedupe.urlSeen('https://example.test/#two')).toBe(true)
    expect(dedupe.resultSeen({ title: 'same', url: 'https://example.test' })).toBe(false)
    expect(dedupe.resultSeen({ url: 'https://example.test', title: 'same' })).toBe(true)
  })
})