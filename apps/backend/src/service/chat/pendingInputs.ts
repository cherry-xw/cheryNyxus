import type { PendingInputSnapshot } from '../message/types.js'
import type { listPendingInputs } from '@/db/pendingInput.js'
import { parseStoredParts } from '@/utils/messageParts.js'
import { backendResumeRequired } from '../backendWork.js'

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
    parts: parseStoredParts(entry.parts),
    createdAt: entry.accepted_at,
    state: entry.state,
    ...(backendResumeRequired(entry.chat_id) ? { reason: '因服务关闭未处理；点击“继续”后按原队列执行，无需重新发送。' } : {}),
    queueSequence: entry.queue_sequence,
    acceptedAt: entry.accepted_at,
  }
}
