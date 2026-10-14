import type { ActiveTurnSnapshot } from '../message/types.js'
import { getExecutionActiveRun } from '@/db/executionGraph.js'
import { getRecentChatEvents } from '@/db/delivery.js'
import { getActiveChatRunId, isChatRunning } from './runtimeCache.js'
import { getLiveTurns } from './liveTurns.js'

export function buildActiveTurns(chatId: string): ActiveTurnSnapshot[] {
  const activeRunId = getActiveChatRunId(chatId)
  if (!isChatRunning(chatId) && !activeRunId) return []
  const turns = new Map<string, ActiveTurnSnapshot>()
  if (activeRunId) {
    const durableRun = getExecutionActiveRun(chatId, activeRunId)
    if (durableRun?.turnId && durableRun.nodeId) {
      turns.set(durableRun.turnId, {
        turnId: durableRun.turnId,
        runId: durableRun.runId,
        messageId: durableRun.nodeId,
        thinking: '',
        content: '',
        thinkingOffset: 0,
        contentOffset: 0,
        nextThinkingOffset: 0,
        nextContentOffset: 0,
        createdAt: Date.now(),
      })
    }
  }
  for (const event of getRecentChatEvents(chatId, 2000)) {
    const e = event as Record<string, unknown>
    const runId = typeof e.runId === 'string' ? e.runId : undefined
    const data = (e.data ?? {}) as Record<string, unknown>
    if (
      e.kind === 'notification' &&
      e.type === 'turn.started' &&
      typeof data.turnId === 'string' &&
      typeof data.messageId === 'string'
    ) {
      const turnRunId = typeof data.runId === 'string' ? data.runId : runId
      if (activeRunId && turnRunId && turnRunId !== activeRunId) continue
      turns.set(data.turnId, {
        turnId: data.turnId,
        ...(turnRunId ? { runId: turnRunId } : {}),
        messageId: data.messageId,
        thinking: '',
        content: '',
        thinkingOffset: 0,
        contentOffset: 0,
        nextThinkingOffset: 0,
        nextContentOffset: 0,
        createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      })
      continue
    }
    if (
      e.kind === 'notification' &&
      e.type === 'turn.delta' &&
      typeof data.turnId === 'string' &&
      typeof data.delta === 'string' &&
      typeof data.offset === 'number'
    ) {
      const turn = turns.get(data.turnId)
      if (!turn) continue
      if (data.channel === 'thinking' && data.offset === turn.thinking.length) {
        turn.thinking += data.delta
        turn.thinkingOffset = turn.thinking.length
        turn.nextThinkingOffset = turn.thinkingOffset
      } else if (data.channel === 'content' && data.offset === turn.content.length) {
        turn.content += data.delta
        turn.contentOffset = turn.content.length
        turn.nextContentOffset = turn.contentOffset
      }
      continue
    }
    if (
      e.kind === 'notification' &&
      (e.type === 'turn.completed' || e.type === 'turn.cancelled') &&
      typeof data.turnId === 'string'
    ) {
      turns.delete(data.turnId)
      continue
    }
    if (
      e.kind === 'notification' &&
      e.type === 'run.outcome'
    ) {
      const terminalRun = runId
      for (const [id, turn] of turns) {
        if (!terminalRun || !turn.runId || turn.runId === terminalRun) turns.delete(id)
      }
    }
  }
  // 当前进程的累计文本覆盖当前 turn 事件投影。
  for (const live of getLiveTurns(chatId)) turns.set(live.turnId, live)
  return [...turns.values()]
}
