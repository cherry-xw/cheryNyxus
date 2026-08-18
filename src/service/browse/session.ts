/**
 * 浏览会话存储（config.workspace.browse.*）。
 *
 * 会话承担：sessionId 鉴权（后续 list 必须出示）+ 固定窗口限流（每会话 rpm）+
 * TTL 过期清理（create/consume 时机会式 sweep，max_sessions 上限内无成本）。
 * 不用 src/utils/rateLimiter.ts 的 getRateLimiter：其注册表键永不 GC 且溢出阻塞等待，
 * 不适合「每会话」的 UI 钻取场景；本存储随会话一起被回收。
 */
import { randomHex } from '@/utils/obfuscate.js'
import type { BrowseRoot } from './sandbox.js'

/** 单会话状态。 */
export interface BrowseSession {
  id: string
  roots: BrowseRoot[]
  createdAt: number
  expiresAt: number
  /** 每分钟请求上限（固定窗口） */
  rpm: number
  callsInWindow: number
  windowStart: number
}

export type ConsumeResult =
  | { ok: true; session: BrowseSession }
  | { ok: false; reason: 'not_found' | 'expired' | 'rate_limited' }

export class BrowseSessionStore {
  private sessions = new Map<string, BrowseSession>()

  create(
    roots: BrowseRoot[],
    ttlMs: number,
    rpm: number,
    maxSessions: number,
  ): { session?: BrowseSession; error?: string } {
    this.sweep(Date.now())
    if (this.sessions.size >= maxSessions) {
      return { error: '浏览会话过多，请稍后重试' }
    }
    const now = Date.now()
    const session: BrowseSession = {
      id: randomHex(16),
      roots,
      createdAt: now,
      expiresAt: now + ttlMs,
      rpm,
      callsInWindow: 0,
      windowStart: now,
    }
    this.sessions.set(session.id, session)
    return { session }
  }

  /** 校验 + 限流 + 触碰窗口。失败返回结构化原因（handler 据此给友好文案）。 */
  consume(sessionId: string): ConsumeResult {
    const now = Date.now()
    const s = this.sessions.get(sessionId)
    if (!s) {
      // 未命中：机会式清理其它过期会话（不删本次目标——本就不存在）
      this.sweep(now)
      return { ok: false, reason: 'not_found' }
    }
    if (now > s.expiresAt) {
      this.sessions.delete(sessionId)
      return { ok: false, reason: 'expired' }
    }
    // 固定窗口限流（每分钟重置计数）
    if (now - s.windowStart >= 60_000) {
      s.windowStart = now
      s.callsInWindow = 0
    }
    if (s.callsInWindow >= s.rpm) return { ok: false, reason: 'rate_limited' }
    s.callsInWindow += 1
    return { ok: true, session: s }
  }

  close(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  get size(): number {
    return this.sessions.size
  }

  /** 清理过期会话（max_sessions 上限内的迭代无成本）。 */
  private sweep(now: number): void {
    for (const [id, s] of this.sessions) {
      if (now > s.expiresAt) this.sessions.delete(id)
    }
  }
}

/** 单例：handler 与测试共用。 */
export const browseSessions = new BrowseSessionStore()
