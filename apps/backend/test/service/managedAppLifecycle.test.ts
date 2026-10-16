import { describe, it, expect, vi } from 'vitest'
import { weeklyCleanupBoundary, lifecycleStopReason, isBusinessActivity } from '../../src/service/managedApp/lifecycle.ts'
import { scheduleNotifications, type AppNotification } from '../../src/service/managedApp/notifications.ts'
import { ManagedAppController } from '../../src/service/managedApp/controller.ts'
import type { ManagedAppRecord } from '../../src/service/managedApp/types.ts'
const now = Date.parse('2026-10-19T04:10:00+08:00')
function app(extra: Partial<ManagedAppRecord> = {}): ManagedAppRecord {
  return { userId: '649207438', appId: 'demo', state: 'running', startedAt: now - 3600000, lastActiveAt: now, leaseExpiresAt: now + 7200000, leaseVersion: 1, weeklyCleanupExempt: false, creatorChannel: { channel: 'qq', selfId: '123456', userId: '649207438', conversationType: 'private' }, ...extra } as ManagedAppRecord
}
describe('managed app lifecycle', () => {
  it('cancels expired publishing work before waiting on the publication lock', async () => {
    const controller = new ManagedAppController() as any
    const record = app({ state: 'starting', leaseExpiresAt: now - 1 })
    const state = { notifications: {}, lastWeeklyCleanupSlot: String(weeklyCleanupBoundary(now)) }
    controller.ledger.getSnapshot = async () => ({ hostMemAvailableBytes: 6e9, hostDiskAvailableBytes: 20e9 })
    controller.store.listAllApps = () => [record]
    controller.store.getState = () => state
    controller.store.save = async () => {}
    const events: string[] = []
    controller.tasks.set('publishing', { result: { userId: record.userId, appId: record.appId, status: 'running', startedAt: now - 10000, finishedAt: null }, cancel: async () => { events.push('cancel'); record.state = 'running' } })
    controller.withAppLock = async (_key: string, callback: () => Promise<void>) => { events.push('lock'); await callback() }
    controller.stopAppServiceLocked = vi.fn(async () => { record.state = 'stopped' })
    expect((await controller.sweepLifecycle(now)).stopped).toBe(1)
    expect(events[0]).toBe('cancel')
    expect(events[1]).toBe('lock')
    expect(controller.stopAppServiceLocked).toHaveBeenCalledWith(record, 'lease_expired')
  })
  it('uses Shanghai Monday 04:00 regardless of host timezone', () => {
    expect(weeklyCleanupBoundary(now)).toBe(Date.parse('2026-10-19T04:00:00+08:00'))
    expect(weeklyCleanupBoundary(Date.parse('2026-10-19T03:59:00+08:00'))).toBe(Date.parse('2026-10-12T04:00:00+08:00'))
  })
  it('catches up old instances but does not stop instances started after cleanup', () => {
    expect(lifecycleStopReason(app(), now, 24)).toBe('weekly_cleanup')
    expect(lifecycleStopReason(app({ startedAt: now }), now, 24)).toBeUndefined()
    expect(lifecycleStopReason(app({ weeklyCleanupExempt: true }), now, 24)).toBeUndefined()
  })
  it('prioritizes lease expiry and bounds busy idle grace', () => {
    expect(lifecycleStopReason(app({ leaseExpiresAt: now }), now, 24, now)).toBe('lease_expired')
    const idle = app({ startedAt: now, lastActiveAt: now - 87000000 })
    expect(lifecycleStopReason(idle, now, 24, now - 1000)).toBeUndefined()
    expect(lifecycleStopReason({ ...idle, lastActiveAt: now - 88200000 }, now, 24, now)).toBe('idle_timeout')
  })
  it('does not count static assets, health, websocket, SSE or polling as activity', () => {
    for (const url of ['/assets/a.js', '/__app_health', '/events', '/ws']) expect(isBusinessActivity('GET', url, undefined)).toBe(false)
    expect(isBusinessActivity('GET', '/api/items', '1')).toBe(false)
    expect(isBusinessActivity('GET', '/', undefined)).toBe(true)
    expect(isBusinessActivity('POST', '/api/items', undefined)).toBe(true)
  })
  it('deduplicates notices, invalidates old versions and contains no activation URL', () => {
    const records: Record<string, AppNotification> = {}
    const record = app()
    scheduleNotifications(record, records, now); scheduleNotifications(record, records, now)
    expect(Object.keys(records)).toHaveLength(1)
    record.leaseVersion++; record.leaseExpiresAt += 864000000
    scheduleNotifications(record, records, now)
    expect(Object.values(records)[0]?.status).toBe('superseded')
    expect(JSON.stringify(records)).not.toContain('activate_token')
  })
  it('claims once and does not retry unknown delivery', async () => {
    const controller = new ManagedAppController()
    const internal = controller as any
    const record = app({ leaseExpiresAt: Date.now() + 200000, startedAt: Date.now() })
    const records: Record<string, AppNotification> = {}
    scheduleNotifications(record, records, Date.now())
    internal.store.getState = () => ({ notifications: records })
    internal.store.getApp = () => record
    internal.store.save = async () => {}
    const first = await controller.claimAppNotifications('123456')
    expect(first).toHaveLength(1)
    expect(await controller.claimAppNotifications('123456')).toHaveLength(0)
    await controller.reportAppNotification({ selfId: '123456', notificationId: first[0]!.id, status: 'unknown' })
    expect(await controller.claimAppNotifications('123456')).toHaveLength(0)
    expect(records[first[0]!.id]?.status).toBe('delivery_uncertain')
  })
})
