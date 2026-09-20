/** Provider counters are cumulative. Undefined means unreported, never zero. */
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface ModelRequestEvent {
  attemptId: string
  chatId: string
  inputMessageId?: string
  model: string
  provider: string
  protocol: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  usage: ModelUsage
  context: { system: number; tools: number; conversation: number; limit: number | null }
}

const observers = new Map<string, Set<(event: ModelRequestEvent) => void>>()

export function observeModelRequests(
  chatId: string,
  listener: (event: ModelRequestEvent) => void,
): () => void {
  const set = observers.get(chatId) ?? new Set()
  set.add(listener)
  observers.set(chatId, set)
  return () => {
    set.delete(listener)
    if (!set.size) observers.delete(chatId)
  }
}

export function reportModelRequest(event: ModelRequestEvent): void {
  for (const listener of observers.get(event.chatId) ?? []) {
    try {
      listener(event)
    } catch {
      /* Observation must not alter execution. */
    }
  }
}

export interface RequestObservation {
  start(model?: string): void
  response(raw: unknown): void
  finish(status: 'completed' | 'failed' | 'cancelled'): void
}
