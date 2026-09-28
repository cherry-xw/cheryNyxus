import type { HistoryItem } from '@/domain/chat/projectionTypes'
import type { ActiveTurnSnapshot, PendingInput } from '@/application/backend/public'

export function pendingInputHistory(inputs: readonly PendingInput[], fallbackChatId: string): HistoryItem[] {
  return inputs
    .filter((input) => !['consumed', 'cancelled', 'rejected'].includes(input.state))
    .map((input) => ({
      role: 'user',
      content: input.content,
      createdAt: input.acceptedAt ?? input.createdAt ?? Date.now(),
      msgId: input.messageId ?? `pending:${input.inputId}`,
      agentChatId: input.chatId ?? fallbackChatId,
    }))
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
