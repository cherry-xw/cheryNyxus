import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRateLimiter } from '@/utils/rateLimiter.js'

describe('runtime RPM updates', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the account window while each request uses its run snapshot', async () => {
    vi.useFakeTimers()
    const url = `http://rpm-${Math.random()}.test`
    const limiter = getRateLimiter(url, 'key')

    await limiter.acquire(2)
    await limiter.acquire(2)
    let released = false
    const stricter = limiter.acquire(1).then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    await stricter
    expect(released).toBe(true)
    expect(getRateLimiter(url, 'key')).toBe(limiter)
  })

  it('a higher later RPM can use remaining capacity without rebuilding the limiter', async () => {
    vi.useFakeTimers()
    const url = `http://rpm-${Math.random()}.test`
    const limiter = getRateLimiter(url, 'key')

    await limiter.acquire(1)
    await expect(limiter.acquire(2)).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
