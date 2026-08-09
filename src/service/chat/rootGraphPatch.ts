import { appendChatEvent } from '@/db/delivery.js'
import { getRootChatId, getTimelineRevision } from '@/db/chat.js'
import { logger } from '@/utils/logger/index.js'
import { createNotification, type RootTimelinePatchOperation } from '../message/types.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { buildCanonicalTimeline, buildRootTimeline } from './handler.js'

/** Broadcast one complete, idempotent root graph patch after a durable mutation. */
export function emitTimelinePatch(chatId: string, baseRevision: number): void {
  const rootChatId = getRootChatId(chatId)
  const rootTimelines = (['conversation', 'tree', 'audit'] as const).map((view) =>
    buildRootTimeline(rootChatId, view),
  )
  const notification = createNotification(
    'timeline.patch',
    undefined,
    {
      chatId,
      baseRevision,
      revision: getTimelineRevision(chatId),
      operations: buildCanonicalTimeline(chatId).map((message) => ({
        type: 'upsert' as const,
        message,
      })),
      rootPatch: toRootPatch(rootTimelines[0]!),
      rootPatches: rootTimelines.map(toRootPatch),
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

function toRootPatch(timeline: ReturnType<typeof buildRootTimeline>) {
  const operations: RootTimelinePatchOperation[] = [
    ...timeline.nodes.map((node) => ({ type: 'upsert' as const, node })),
    ...timeline.edges.map((edge) => ({ type: 'upsert-edge' as const, edge })),
    ...timeline.activeRuns.map((run) => ({ type: 'upsert-run' as const, run })),
    ...timeline.pendingInputs.map((input) => ({ type: 'upsert-input' as const, input })),
  ]
  return {
    rootChatId: timeline.rootChatId,
    view: timeline.view,
    baseRevision: Math.max(0, timeline.revision - 1),
    revision: timeline.revision,
    operations,
  }
}
