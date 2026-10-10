import type { ActiveTurnSnapshot } from '../message/types.js'
import { getExecutionActiveRun } from '@/db/executionGraph.js'
import { getRecentChatEvents } from '@/db/delivery.js'
import { getActiveChatRunId, isChatRunning } from './runtimeCache.js'
import { getLiveTurns } from './liveTurns.js'

export function buildActiveTurns(chatId: string): ActiveTurnSnapshot[] {
  const activeRunId = getActiveChatRunId(chatId)
  if (!isChatRunning(chatId) && !activeRunId) return []
  const turns = new Map<string, ActiveTurnSnapshot>()
  const v2MessageIds = new Set<string>()
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
      v2MessageIds.add(data.messageId)
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
      const completed = turns.get(data.turnId)
      turns.delete(data.turnId)
      if (completed) v2MessageIds.delete(completed.messageId)
      continue
    }
    if (e.kind === 'chunk' && e.type === 'stream' && typeof data.msgId === 'string') {
      if (activeRunId && runId && runId !== activeRunId) continue
      const id = data.msgId
      // V2 turn events are authoritative. Legacy chunks only reconstruct chats
      // created before the turn lifecycle protocol was available.
      if (v2MessageIds.has(id)) continue
      const current = turns.get(id) ?? {
        turnId: id,
        messageId: id,
        ...(runId ? { runId } : {}),
        thinking: '',
        content: '',
        thinkingOffset: 0,
        contentOffset: 0,
        nextThinkingOffset: 0,
        nextContentOffset: 0,
        createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      }
      if (typeof data.thinking === 'string') {
        current.thinking += data.thinking
        current.thinkingOffset = current.thinking.length
        current.nextThinkingOffset = current.thinkingOffset
      }
      if (typeof data.content === 'string') {
        current.content += data.content
        current.contentOffset = current.content.length
        current.nextContentOffset = current.contentOffset
      }
      turns.set(id, current)
    }
    if (e.kind === 'chunk' && e.type === 'staged' && typeof data.msgId === 'string') {
      if (data.type === 'content_end' || data.type === 'sense_end') turns.delete(data.msgId)
    }
    if (
      e.kind === 'notification' &&
      (e.type === 'done' || e.type === 'error' || e.type === 'run.outcome')
    ) {
      const terminalRun = runId
      for (const [id, turn] of turns) {
        if (!terminalRun || !turn.runId || turn.runId === terminalRun) turns.delete(id)
      }
    }
  }
  // 新运行不再持久化逐 token delta；当前进程内的累计文本覆盖兼容事件重建结果。
  // 旧数据库中仍保留的 delta 继续由上面的扫描读取，不需要迁移。
  for (const live of getLiveTurns(chatId)) turns.set(live.turnId, live)
  return [...turns.values()]
}
