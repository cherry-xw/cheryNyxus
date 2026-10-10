import type { ApprovalState } from '@/domain/chat/projectionTypes'

/**
 * 剩余秒数（用于闪烁周期）。
 * waitTime=0（不超时）→ Infinity → 周期封顶 5s。
 */
export function remainingSecOf(a: ApprovalState, now: number): number {
  if (a.waitTime <= 0) return Infinity
  return Math.max(0, (a.waitTime - (now - a.createdAt)) / 1000)
}

/** icon 闪烁周期（秒）：剩余越少越快，封顶 [0.2, 5]s。 */
export function flashPeriodOf(a: ApprovalState, now: number): number {
  const s = remainingSecOf(a, now)
  if (!isFinite(s)) return 5
  return Math.max(0.2, Math.min(5, s * 0.1))
}

/** icon 是否已超时（remaining <= 0）：CSS 控制淡出 */
export function isExpired(a: ApprovalState, now: number): boolean {
  return a.waitTime > 0 && remainingSecOf(a, now) <= 0
}
