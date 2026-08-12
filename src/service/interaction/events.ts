import type { InteractionRecord } from '@/db/interaction.js'
import { createNotification } from '../message/types.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { logger } from '@/utils/logger/index.js'

/** Inbox state is global, so every connected client receives a lightweight invalidation. */
export function broadcastInteractionChanged(record: InteractionRecord | undefined): void {
  if (!record) return
  const notification = createNotification('interaction.changed', undefined, {
    interactionId: record.interactionId,
    status: record.status,
    revision: record.revision,
  })
  for (const ws of connectionManager.getAllOutputs()) {
    try {
      ws.send(transport.encode(notification))
    } catch (cause) {
      logger.event('interaction.changed.output_failed', {
        interactionId: record.interactionId,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
}
