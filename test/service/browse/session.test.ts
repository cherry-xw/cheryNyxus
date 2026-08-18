import { describe, expect, it } from 'vitest'
import { BrowseSessionStore } from '@/service/browse/session.js'
import type { BrowseRoot } from '@/service/browse/sandbox.js'

const ROOT: BrowseRoot = { path: '/x', name: 'x' }

describe('BrowseSessionStore', () => {
  it('create → consume 正常；consume 计数递增', () => {
    const store = new BrowseSessionStore()
    const { session, error } = store.create([ROOT], 60_000, 60, 20)
    expect(error).toBeUndefined()
    expect(session).toBeDefined()
    const first = store.consume(session!.id)
    expect(first.ok).toBe(true)
    expect(first.ok && first.session.callsInWindow).toBe(1)
  })

  it('未知 sessionId → not_found', () => {
    const store = new BrowseSessionStore()
    const r = store.consume('deadbeef')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('TTL 过期（负 ttl）→ expired 并清理', () => {
    const store = new BrowseSessionStore()
    const { session } = store.create([ROOT], -1000, 60, 20)
    expect(store.size).toBe(1)
    const r = store.consume(session!.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('expired')
    expect(store.size).toBe(0)
  })

  it('每会话 rpm 超限 → rate_limited', () => {
    const store = new BrowseSessionStore()
    const { session } = store.create([ROOT], 60_000, 1, 20)
    expect(store.consume(session!.id).ok).toBe(true)
    const r = store.consume(session!.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('rate_limited')
  })

  it('max_sessions 上限 → 拒绝新会话', () => {
    const store = new BrowseSessionStore()
    expect(store.create([ROOT], 60_000, 60, 1).error).toBeUndefined()
    const second = store.create([ROOT], 60_000, 60, 1)
    expect(second.session).toBeUndefined()
    expect(second.error).toContain('过多')
  })

  it('close → 后续 consume not_found', () => {
    const store = new BrowseSessionStore()
    const { session } = store.create([ROOT], 60_000, 60, 20)
    store.close(session!.id)
    const r = store.consume(session!.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_found')
  })

  it('sweep：过期会话在下次 create 时被清理', () => {
    const store = new BrowseSessionStore()
    store.create([ROOT], -1000, 60, 20)
    expect(store.size).toBe(1)
    store.create([ROOT], 60_000, 60, 20)
    expect(store.size).toBe(1) // 过期已清，仅剩新会话
  })
})
