import { RelayError } from './errors.js'

interface WindowState {
  startedAt: number
  count: number
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>()

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  consume(key: string, now = Date.now()): void {
    const current = this.windows.get(key)
    if (!current || now - current.startedAt >= this.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 })
      this.prune(now)
      return
    }
    if (current.count >= this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.startedAt + this.windowMs - now) / 1000))
      throw new RelayError('RATE_LIMITED', 'Request rate limit exceeded', retryAfterSeconds)
    }
    current.count += 1
  }

  private prune(now: number): void {
    if (this.windows.size < 10_000) return
    for (const [key, value] of this.windows) {
      if (now - value.startedAt >= this.windowMs) this.windows.delete(key)
    }
  }
}
