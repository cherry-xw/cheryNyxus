import type { ManagedAppRecord } from './types.ts'

export interface AppNotification {
  id: string
  userId: string
  appId: string
  leaseVersion: number
  stage: 'T_24H' | 'T_1H' | 'STOPPED'
  status: 'pending' | 'inflight' | 'sent' | 'failed' | 'delivery_uncertain' | 'superseded'
  attempts: number
  retryAt: number
  creatorChannel: NonNullable<ManagedAppRecord['creatorChannel']>
  text: string
}

export function scheduleNotifications(app: ManagedAppRecord, records: Record<string, AppNotification>, now: number): void {
  for (const item of Object.values(records)) {
    if (item.userId === app.userId && item.appId === app.appId && item.leaseVersion !== app.leaseVersion && item.status === 'pending') item.status = 'superseded'
  }
  if (!app.creatorChannel) return
  const remaining = app.leaseExpiresAt - now
  const stage = app.state === 'stopped' && ['idle_timeout', 'lease_expired', 'weekly_cleanup'].includes(app.stopReason ?? '') ? 'STOPPED'
    : app.state === 'running' && remaining > 0 && remaining <= 3600000 ? 'T_1H'
    : app.state === 'running' && remaining > 3600000 && remaining <= 86400000 ? 'T_24H' : undefined
  if (!stage) return
  const id = `${app.userId}:${app.appId}:${app.leaseVersion}:${stage}`
  if (records[id]) return
  records[id] = { id, userId: app.userId, appId: app.appId, leaseVersion: app.leaseVersion, stage, status: 'pending', attempts: 0, retryAt: now, creatorChannel: app.creatorChannel,
    text: stage === 'STOPPED' ? `应用 ${app.appId} 已停止（${app.stopReason}），数据已保留，可在对话中请求重新启动。` : `应用 ${app.appId} 将在${stage === 'T_1H' ? '1 小时内' : '24 小时内'}到期，可在对话中请求续期；到期停止不会删除数据。` }
}
