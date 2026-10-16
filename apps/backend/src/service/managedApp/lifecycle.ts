import type { ManagedAppRecord, StopReason } from './types.ts'

/** Most recent Monday 04:00 in Asia/Shanghai; arithmetic avoids host timezone dependence. */
export function weeklyCleanupBoundary(now: number): number {
  const offset = 8 * 60 * 60 * 1000
  const local = new Date(now + offset)
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 4)
  const monday = day - ((local.getUTCDay() + 6) % 7) * 86400000
  const boundary = monday - offset
  return boundary <= now ? boundary : boundary - 7 * 86400000
}

export function lifecycleStopReason(app: ManagedAppRecord, now: number, idleHours: number, busySince?: number): StopReason | undefined {
  if (app.state !== 'running') return
  if (app.leaseExpiresAt <= now) return 'lease_expired'
  const boundary = weeklyCleanupBoundary(now)
  if (!app.weeklyCleanupExempt && app.startedAt !== null && app.startedAt < boundary) return 'weekly_cleanup'
  if (now - app.lastActiveAt >= idleHours * 3600000 && (busySince === undefined || now - app.lastActiveAt >= idleHours * 3600000 + 1800000)) return 'idle_timeout'
}

export function isBusinessActivity(method: string, url: string, poll: string | undefined): boolean {
  if (poll === '1' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false
  const pathname = url.split('?')[0]!
  if (/\/(?:__app_health|events|ws)(?:\/|$)/.test(pathname)) return false
  return !/\.[a-z0-9]{1,8}$/i.test(pathname)
}
