import type { ChatLifecycleChanged } from '@chery/protocol'
import { createNotification } from '../message/types.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { logger } from '@/utils/logger/index.js'

const listeners = new Set<(data: ChatLifecycleChanged) => void>()
export function onChatLifecycle(listener: (data: ChatLifecycleChanged) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function broadcastChatLifecycle(data: ChatLifecycleChanged): void {
  if (!data.chatIds.length) return
  for (const listener of listeners) {
    try {
      listener(data)
    } catch {
      /* Optional observers never block lifecycle changes. */
    }
  }
  const notification = createNotification('chat.lifecycle.changed', undefined, data)
  for (const ws of connectionManager.getAllOutputs()) {
    try {
      ws.send(transport.encode(notification))
    } catch (cause) {
      logger.event('chat.lifecycle.output_failed', { message: String(cause) })
    }
  }
}
