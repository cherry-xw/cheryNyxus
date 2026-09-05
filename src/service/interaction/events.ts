import type { InteractionRecord } from '@/db/interaction.js'
import { createNotification } from '../message/types.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { applyLiteEvent } from '../websocket/liteProjection.js'
import { logger } from '@/utils/logger/index.js'
import { publishOverviewForChat } from '../chat/overview.js'

/** Inbox state is global, so every connected client receives a lightweight invalidation. */
export function broadcastInteractionChanged(record: InteractionRecord | undefined): void {
  if (!record) return
  publishOverviewForChat(record.chatId, {
    kind: record.status === 'pending' ? 'waiting_user' : 'resumed',
    label: record.status === 'pending' ? '等待用户处理' : '用户操作已更新',
    at: record.updatedAt,
  })
  for (const ws of connectionManager.getAllOutputs()) {
    try {
      const profile = connectionManager.get(ws)?.profile
      if (profile) {
        // lite 旁路（T7 修正2 出口二）：同一投影 + D18 presetId 注入（消多 agent 重拉放大）。
        const notification = createNotification('interaction.changed', undefined, {
          interactionId: record.interactionId,
          status: record.status,
          revision: record.revision,
          ...(record.presetId ? { presetId: record.presetId } : {}),
        })
        const projected = applyLiteEvent(profile, notification)
        if (projected !== undefined) ws.send(transport.encode(projected as never))
        continue
      }
      const notification = createNotification('interaction.changed', undefined, {
        interactionId: record.interactionId,
        status: record.status,
        revision: record.revision,
        interaction: record,
      })
      ws.send(transport.encode(notification))
    } catch (cause) {
      logger.event('interaction.changed.output_failed', {
        interactionId: record.interactionId,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
}
