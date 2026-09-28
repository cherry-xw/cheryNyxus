import type { PendingInputSnapshot } from '../message/types.js'
import type { listPendingInputs } from '@/db/pendingInput.js'

/** Preserve the single-chat and root-snapshot shapes, including optional source chat identity. */
export function pendingInputSnapshot(
  entry: ReturnType<typeof listPendingInputs>[number],
  chatId?: string,
): PendingInputSnapshot {
  return {
    ...(chatId ? { chatId } : {}),
    inputId: entry.input_id,
    ...(entry.client_message_id ? { clientMessageId: entry.client_message_id } : {}),
    messageId: entry.message_id,
    content: entry.content,
    createdAt: entry.accepted_at,
    state: entry.state,
    queueSequence: entry.queue_sequence,
    acceptedAt: entry.accepted_at,
  }
}
