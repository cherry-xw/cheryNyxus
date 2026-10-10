import type { ActiveTurnSnapshot } from '../message/types.js'

interface LiveTurnInput {
  chatId: string
  runId: string
  turnId: string
  messageId: string
  createdAt: number
}

type LiveChannel = 'thinking' | 'content'

/**
 * 当前进程中的未完成模型输出。
 *
 * 逐 token delta 只服务实时界面，不属于历史审计单元，因此不写 chat_events/root_events。
 * chat.open/chat.attach 从这里取得当前累计文本；模型消息封口后，权威内容由 messages 和
 * timeline patch 接管，本缓冲立即释放。进程退出时未封口的半截文本按设计丢弃。
 */
const turnsByChat = new Map<string, Map<string, ActiveTurnSnapshot>>()

function chatTurns(chatId: string): Map<string, ActiveTurnSnapshot> {
  const existing = turnsByChat.get(chatId)
  if (existing) return existing
  const created = new Map<string, ActiveTurnSnapshot>()
  turnsByChat.set(chatId, created)
  return created
}

export function startLiveTurn(input: LiveTurnInput): void {
  const turns = chatTurns(input.chatId)
  if (turns.has(input.turnId)) return
  turns.set(input.turnId, {
    turnId: input.turnId,
    messageId: input.messageId,
    runId: input.runId,
    thinking: '',
    content: '',
    thinkingOffset: 0,
    contentOffset: 0,
    nextThinkingOffset: 0,
    nextContentOffset: 0,
    createdAt: input.createdAt,
  })
}

export function appendLiveTurnDelta(
  chatId: string,
  turnId: string,
  channel: LiveChannel,
  offset: number,
  delta: string,
): void {
  const turn = turnsByChat.get(chatId)?.get(turnId)
  if (!turn || !delta) return
  const current = turn[channel]
  if (offset !== current.length) {
    throw new Error(
      `live turn delta offset mismatch: ${chatId}/${turnId}/${channel} expected ${current.length}, got ${offset}`,
    )
  }
  turn[channel] += delta
  const nextOffset = offset + delta.length
  if (channel === 'thinking') {
    turn.thinkingOffset = nextOffset
    turn.nextThinkingOffset = nextOffset
  } else {
    turn.contentOffset = nextOffset
    turn.nextContentOffset = nextOffset
  }
}

export function completeLiveTurn(chatId: string, turnId: string): void {
  const turns = turnsByChat.get(chatId)
  if (!turns) return
  turns.delete(turnId)
  if (turns.size === 0) turnsByChat.delete(chatId)
}

export function clearLiveRun(chatId: string, runId: string): void {
  const turns = turnsByChat.get(chatId)
  if (!turns) return
  for (const [turnId, turn] of turns) {
    if (turn.runId === runId) turns.delete(turnId)
  }
  if (turns.size === 0) turnsByChat.delete(chatId)
}

export function getLiveTurns(chatId: string): ActiveTurnSnapshot[] {
  return [...(turnsByChat.get(chatId)?.values() ?? [])].map((turn) => ({ ...turn }))
}
