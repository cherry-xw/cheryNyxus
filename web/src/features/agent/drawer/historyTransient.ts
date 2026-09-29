import type { HistoryItem } from '@/domain/chat/projectionTypes'
import type { ActiveTurnSnapshot, PendingInput } from '@/application/backend/public'

export function pendingInputHistory(inputs: readonly PendingInput[], fallbackChatId: string): HistoryItem[] {
  return inputs
    .filter((input) => !['consumed', 'cancelled', 'rejected'].includes(input.state))
    .slice()
    .sort(
      (a, b) =>
        (a.queueSequence ?? Number.MAX_SAFE_INTEGER) -
          (b.queueSequence ?? Number.MAX_SAFE_INTEGER) ||
        (a.acceptedAt ?? a.createdAt ?? 0) - (b.acceptedAt ?? b.createdAt ?? 0) ||
        a.inputId.localeCompare(b.inputId),
    )
    .map((input) => ({
      role: 'user',
      content: input.content,
      createdAt: input.acceptedAt ?? input.createdAt ?? Date.now(),
      msgId: input.messageId ?? `pending:${input.inputId}`,
      agentChatId: input.chatId ?? fallbackChatId,
      pendingInputState: input.state,
      pendingInputId: input.inputId,
      ...(input.queueSequence !== undefined
        ? { pendingInputQueueSequence: input.queueSequence }
        : {}),
      ...(input.clientMessageId ? { pendingClientMessageId: input.clientMessageId } : {}),
    }))
}

/** Keep queued user rows after the current response and avoid duplicating a canonical message. */
export function appendQueuedInputsAfterHistory(
  history: readonly HistoryItem[],
  queued: readonly HistoryItem[],
): HistoryItem[] {
  const existingIds = new Set(history.map((item) => item.msgId).filter(Boolean))
  return [...history, ...queued.filter((item) => !existingIds.has(item.msgId))]
}

export function activeTurnHistory(turns: readonly ActiveTurnSnapshot[], fallbackChatId: string): HistoryItem[] {
  return turns.map((turn) => ({
    role: 'assistant',
    content: turn.content,
    thinking: turn.thinking || undefined,
    createdAt: turn.createdAt ?? Date.now(),
    msgId: turn.messageId,
    agentChatId: turn.chatId ?? fallbackChatId,
  }))
}
