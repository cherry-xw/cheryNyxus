import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'

/**
 * 滑动窗口时间（毫秒）。RPM = Requests Per Minute，窗口固定 60s。
 */
const WINDOW_MS = 60_000

/**
 * 滑动窗口限流器（严格 RPM）。
 *
 * 维护一个单调递增的「放行时刻」数组 slots：任意 60s 滑动窗口内放行的
 * 请求数不超过 rpm。
 *
 * 并发安全：acquire 的同步段（清理 + 预约 slot + push）在首个 await 前
 * 一次性完成，Node 事件循环不会在其中途交错，多个并发请求串行预约，
 * 不会超发。
 *
 * 预约公式：
 *   - slots 未满（len < rpm）：slot = now，立即放行
 *   - slots 已满：slot = slots[len - rpm] + WINDOW_MS
 *     （排在当前请求前第 rpm 个的放行时刻 + 60s，保证窗口合法）
 */
class SlidingWindowRateLimiter {
  /** 放行时刻数组（单调递增，含已预约的未来时刻） */
  private slots: number[] = []

  constructor(private readonly rpm: number) {
    if (rpm <= 0) throw new Error(`rpm must be positive, got: ${rpm}`)
  }

  /**
   * 预约一个放行名额，必要时阻塞等待。
   * 超出限额时 await sleep 到 slot 时刻，对调用方透明。
   */
  async acquire(): Promise<void> {
    // ===== 同步段：清理 + 预约（首个 await 前，原子不交错） =====
    const now = Date.now()

    // 清理已离开窗口的放行时刻（<= now - WINDOW_MS）；?? Infinity 处理 noUncheckedIndexedAccess
    while (this.slots.length > 0 && (this.slots[0] ?? Infinity) <= now - WINDOW_MS) {
      this.slots.shift()
    }

    let slot: number
    if (this.slots.length < this.rpm) {
      // 窗口内未满，立即放行
      slot = now
    } else {
      // 排在当前请求前第 rpm 个的放行时刻 + 60s
      // pivotIndex >= 0（因 length >= rpm）；?? now 仅防御 noUncheckedIndexedAccess
      const pivot = this.slots[this.slots.length - this.rpm] ?? now
      slot = pivot + WINDOW_MS
    }
    this.slots.push(slot)

    const waitMs = slot - now

    // ===== 让出点：必要时等待 =====
    if (waitMs > 0) {
      logger.event('rateLimit.wait', { rpm: this.rpm, waitMs }, LogLevel.debug)
      await sleep(waitMs)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 限流器单例注册表：按 (url, key) 共享。
 * 同一账号（url+key）下的所有 chat 复用同一个限流器，
 * 即使 provider 每次请求 new 一个 client，配额仍正确共享。
 */
const limiterRegistry = new Map<string, SlidingWindowRateLimiter>()

function limiterKey(url: string, key?: string): string {
  return `${url}::${key ?? ''}`
}

/**
 * 获取（或创建）(url, key) 对应的限流器。
 * rpm 仅在首次创建时生效；已存在的限流器忽略后续 rpm 参数
 * （同一账号以首次声明的 rpm 为准）。
 */
export function getRateLimiter(
  url: string,
  key: string | undefined,
  rpm: number,
): SlidingWindowRateLimiter {
  const k = limiterKey(url, key)
  let limiter = limiterRegistry.get(k)
  if (!limiter) {
    limiter = new SlidingWindowRateLimiter(rpm)
    limiterRegistry.set(k, limiter)
  }
  return limiter
}
