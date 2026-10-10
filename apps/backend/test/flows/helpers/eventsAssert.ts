/**
 * Tier 2 流程测试 S2C 事件断言 helper：对称 test/agent/helpers/chunkAssert.ts，
 * 但处理线上层（已编码）的 Chunk | Notification（来自 @/service/message/types），
 * 而非中间件层 MiddlewareChunk。
 *
 * 事件来源：RpcClient 的 handle.events（按 requestId 归属）+ client.background（异步事件）。
 */
import type { Chunk, Notification, StagedChunkData } from '@/service/message/types.js'

export type S2CEvent = Chunk | Notification

export function allEvents(...sources: Array<S2CEvent[] | undefined>): S2CEvent[] {
  return sources.filter(Boolean).flat() as S2CEvent[]
}

export function notifications(events: S2CEvent[]): Notification[] {
  return events.filter((e) => e.kind === 'notification') as Notification[]
}

export function notificationsByType(
  events: S2CEvent[],
  type: Notification['type'],
): Notification[] {
  return notifications(events).filter((n) => n.type === type)
}

export function firstNotification<T = Notification>(
  events: S2CEvent[],
  type: Notification['type'],
): T | undefined {
  return notificationsByType(events, type)[0] as T | undefined
}

export function chunks(events: S2CEvent[]): Chunk[] {
  return events.filter((e) => e.kind === 'chunk') as Chunk[]
}

export function streamChunks(events: S2CEvent[]): Chunk[] {
  return chunks(events).filter((c) => c.type === 'stream')
}

export function stagedChunks(events: S2CEvent[]): Chunk[] {
  return chunks(events).filter((c) => c.type === 'staged')
}

export function stagedTypes(events: S2CEvent[]): StagedChunkData['type'][] {
  return stagedChunks(events).map((c) => (c.data as StagedChunkData).type)
}

export function collectStreamContent(events: S2CEvent[]): string {
  return streamChunks(events)
    .map((c) => (c.data as { content?: string }).content ?? '')
    .join('')
}

/** interrupt notification（confirm/manual 审批请求）。 */
export function interrupts(events: S2CEvent[]) {
  return notificationsByType(events, 'interrupt')
}

export function accepts(events: S2CEvent[]) {
  return notificationsByType(events, 'accept')
}

export function rejecteds(events: S2CEvent[]) {
  return notificationsByType(events, 'rejected')
}

export function dones(events: S2CEvent[]) {
  return notificationsByType(events, 'done')
}

export function errors(events: S2CEvent[]) {
  return notificationsByType(events, 'error')
}

export function hasDone(events: S2CEvent[]): boolean {
  return dones(events).length > 0
}

/**
 * 轮询等待某事件出现（实时流场景：run 进行中事件异步到达）。
 * 默认 5s 超时。predicate 返回 truthy 即取其返回值 resolve。
 */
export async function waitFor<T>(
  source: () => S2CEvent[] | undefined,
  predicate: (events: S2CEvent[]) => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = source() ?? []
    const hit = predicate(events)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

export function waitForNotification(
  source: () => S2CEvent[] | undefined,
  type: Notification['type'],
  timeoutMs?: number,
): Promise<Notification> {
  return waitFor(source, (events) => firstNotification(events, type), timeoutMs)
}
