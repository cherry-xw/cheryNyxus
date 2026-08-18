import { appendChatEvent } from '@/db/delivery.js'
import { getRootChatId, getTimelineRevision } from '@/db/chat.js'
import { logger } from '@/utils/logger/index.js'
import {
  createNotification,
  type RootTimelinePatchData,
  type RootTimelinePatchOperation,
  type RootTimelineSnapshot,
  type TimelinePatchOperation,
} from '../message/types.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { buildCanonicalTimeline, buildRootTimeline } from './handler.js'

/**
 * timeline.patch 增量化：模块级缓存上次已发送的 JSON 事实，diff 后只推
 * 新增/变化（upsert）与消失（remove/remove-edge/remove-run/remove-input）。
 * 缓存未命中（进程重启后首次）退化为全量 upsert（等价旧行为，安全兜底）。
 * 三个 view 的 nodes/edges/activeRuns/pendingInputs 相同，diff 共享计算一次，
 * view 字段各自包装。revision/baseRevision 语义不变。
 */

interface RootGraphCache {
  nodeJson: Map<string, string>
  edgeJson: Map<string, string>
  /** key = `${chatId}:${runId}`（二者均为 UUID，无 ':' 冲突） */
  runJson: Map<string, string>
  inputJson: Map<string, string>
}

const rootGraphCaches = new Map<string, RootGraphCache>()
/** 单 chat canonical message 上次已发送 JSON（key = message id） */
const canonicalCaches = new Map<string, Map<string, string>>()

function diffRootOperations(
  timeline: RootTimelineSnapshot,
  previous: RootGraphCache | undefined,
): RootTimelinePatchOperation[] {
  const nodeJson = new Map(timeline.nodes.map((node) => [node.id, JSON.stringify(node)]))
  const edgeJson = new Map(timeline.edges.map((edge) => [edge.id, JSON.stringify(edge)]))
  const runJson = new Map(
    timeline.activeRuns.map((run) => [`${run.chatId}:${run.runId}`, JSON.stringify(run)]),
  )
  const inputJson = new Map(
    timeline.pendingInputs.map((input) => [input.inputId, JSON.stringify(input)]),
  )
  rootGraphCaches.set(timeline.rootChatId, { nodeJson, edgeJson, runJson, inputJson })

  if (!previous) {
    // 进程重启后首次：全量 upsert
    return [
      ...timeline.nodes.map((node) => ({ type: 'upsert' as const, node })),
      ...timeline.edges.map((edge) => ({ type: 'upsert-edge' as const, edge })),
      ...timeline.activeRuns.map((run) => ({ type: 'upsert-run' as const, run })),
      ...timeline.pendingInputs.map((input) => ({ type: 'upsert-input' as const, input })),
    ]
  }
  const operations: RootTimelinePatchOperation[] = []
  for (const node of timeline.nodes) {
    if (previous.nodeJson.get(node.id) !== nodeJson.get(node.id)) {
      operations.push({ type: 'upsert', node })
    }
  }
  for (const id of previous.nodeJson.keys()) {
    if (!nodeJson.has(id)) operations.push({ type: 'remove', nodeId: id })
  }
  for (const edge of timeline.edges) {
    if (previous.edgeJson.get(edge.id) !== edgeJson.get(edge.id)) {
      operations.push({ type: 'upsert-edge', edge })
    }
  }
  for (const id of previous.edgeJson.keys()) {
    if (!edgeJson.has(id)) operations.push({ type: 'remove-edge', edgeId: id })
  }
  for (const run of timeline.activeRuns) {
    const key = `${run.chatId}:${run.runId}`
    if (previous.runJson.get(key) !== runJson.get(key)) {
      operations.push({ type: 'upsert-run', run })
    }
  }
  for (const key of previous.runJson.keys()) {
    if (runJson.has(key)) continue
    const [chatId, runId] = key.split(':')
    if (!chatId || !runId) continue
    operations.push({ type: 'remove-run', chatId, runId })
  }
  for (const input of timeline.pendingInputs) {
    if (previous.inputJson.get(input.inputId) !== inputJson.get(input.inputId)) {
      operations.push({ type: 'upsert-input', input })
    }
  }
  for (const id of previous.inputJson.keys()) {
    if (!inputJson.has(id)) operations.push({ type: 'remove-input', inputId: id })
  }
  return operations
}

function canonicalOperations(chatId: string): TimelinePatchOperation[] {
  const messages = buildCanonicalTimeline(chatId)
  const next = new Map(messages.map((message) => [message.id, JSON.stringify(message)]))
  const previous = canonicalCaches.get(chatId)
  canonicalCaches.set(chatId, next)
  if (!previous) {
    return messages.map((message) => ({ type: 'upsert' as const, message }))
  }
  const operations: TimelinePatchOperation[] = []
  for (const message of messages) {
    if (previous.get(message.id) !== next.get(message.id)) {
      operations.push({ type: 'upsert', message })
    }
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) operations.push({ type: 'remove', messageId: id })
  }
  return operations
}

function toRootPatch(
  timeline: RootTimelineSnapshot,
  operations: RootTimelinePatchOperation[],
  revision = timeline.revision,
): RootTimelinePatchData {
  return {
    rootChatId: timeline.rootChatId,
    view: timeline.view,
    baseRevision: Math.max(0, revision - 1),
    revision,
    operations,
    ...(timeline.controlState ? { controlState: timeline.controlState } : {}),
  }
}

/** Broadcast one complete, idempotent root graph patch after a durable mutation. */
export function emitTimelinePatch(chatId: string, baseRevision: number): void {
  const rootChatId = getRootChatId(chatId)
  const rootTimelines = (['conversation', 'tree', 'audit'] as const).map((view) =>
    buildRootTimeline(rootChatId, view),
  )
  // 同轮三 view 统一 revision：view[0] 的 build 可能因回填改图 bump revision，
  // 后续 view 才读到新值——取 max 保证三 view patch 的 base/revision 链一致。
  const revision = Math.max(...rootTimelines.map((timeline) => timeline.revision))
  const rootOperations = diffRootOperations(rootTimelines[0]!, rootGraphCaches.get(rootChatId))
  const notification = createNotification(
    'timeline.patch',
    undefined,
    {
      chatId,
      baseRevision,
      revision: getTimelineRevision(chatId),
      operations: canonicalOperations(chatId),
      rootPatch: toRootPatch(rootTimelines[0]!, rootOperations, revision),
      rootPatches: rootTimelines.map((timeline) => toRootPatch(timeline, rootOperations, revision)),
    },
    { chatId },
  )
  notification.seq = appendChatEvent(chatId, notification as unknown as Record<string, unknown>)
  for (const ws of connectionManager.getChatOutputs(chatId)) {
    if (ws.readyState !== ws.OPEN) continue
    for (const routed of connectionManager.prepareSessionEvent(ws, notification)) {
      try {
        ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
      } catch (error) {
        logger.event('timeline.patch.send_failed', { chatId, message: (error as Error).message })
      }
    }
  }
}
