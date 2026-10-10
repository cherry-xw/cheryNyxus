import type { ChatSession, ChatMessage, ChatEvent } from '../../types'
import type { ContextBreakdown } from '@/services/agentApi'
import { extractMediaUrls } from '@/utils/mediaUrls'
import { legacyErrorOutcome, parseRunOutcome } from '@/domain/chat/runOutcome'

export interface OutcomeContext { now: number }
type UpsertMessage = (session: ChatSession, item: Partial<ChatMessage> & { msgId: string }) => void

const ERROR_SOURCES = new Set([
  'brain',
  'sense',
  'media',
  'mcp',
  'chat',
  'system',
  'hook',
  'config',
  'transport',
])

function structuredRunError(
  data: Record<string, unknown>,
  fallbackTracingId: string,
): NonNullable<ChatSession['run']['errorFact']> {
  const source =
    typeof data.source === 'string' && ERROR_SOURCES.has(data.source) ? data.source : 'system'
  return {
    code: typeof data.code === 'string' && data.code.length > 0 ? data.code : 'INTERNAL',
    message:
      typeof data.message === 'string' && data.message.length > 0
        ? data.message
        : '系统出了点小问题',
    source: source as NonNullable<ChatSession['run']['errorFact']>['source'],
    retryable: typeof data.retryable === 'boolean' ? data.retryable : false,
    ...(typeof data.detail === 'string' && data.detail.length > 0 ? { detail: data.detail } : {}),
    tracingId:
      typeof data.tracingId === 'string' && data.tracingId.length > 0
        ? data.tracingId
        : fallbackTracingId,
    ...(typeof data.retryAfterMs === 'number' ? { retryAfterMs: data.retryAfterMs } : {}),
    ...(typeof data.canResume === 'boolean' ? { canResume: data.canResume } : {}),
  }
}

function applyOutcomeResultData(
  session: ChatSession,
  data: Record<string, unknown>,
  replaying: boolean,
  ctx: OutcomeContext,
  upsertMessage: UpsertMessage,
): void {
  const fm = data.finalMessage as
    | {
        msgId: string
        role: 'assistant'
        content: string
        thinking?: string
        createdAt: number
        agentChatId?: string
        contextCompaction?: boolean
        contextCompactionTokens?: number
      }
    | undefined
  if (fm) {
    upsertMessage(session, {
      msgId: fm.msgId,
      role: 'assistant',
      content: fm.content,
      status: 'sealed',
      createdAt: fm.createdAt,
      agentChatId: fm.agentChatId ?? session.chatId,
      ...(fm.thinking ? { thinking: fm.thinking } : {}),
      ...(fm.contextCompaction ? { contextCompaction: true } : {}),
      ...(fm.contextCompactionTokens !== undefined
        ? { contextCompactionTokens: fm.contextCompactionTokens }
        : {}),
    })
    const sealed = session.messagesById[fm.msgId]
    if (sealed) {
      sealed.content = fm.content
      if (fm.thinking !== undefined) sealed.thinking = fm.thinking
      sealed.status = 'sealed'
      const mediaAssets = extractMediaUrls(sealed.content)
      if (mediaAssets.length > 0) sealed.mediaAssets = mediaAssets
    }
    if (session.activeMessageId === fm.msgId) session.activeMessageId = undefined
  }
  if (typeof data.contextUsage === 'number') session.context.contextUsage = data.contextUsage
  if (!replaying && typeof data.serverNow === 'number') {
    session.context.serverClockOffsetMs = data.serverNow - ctx.now
  }
  if (typeof data.used === 'number') session.context.contextUsed = data.used
  if (typeof data.total === 'number') session.context.contextTotal = data.total
  if (data.contextBreakdown)
    session.context.contextBreakdown = data.contextBreakdown as ContextBreakdown
  if (data.finished === true) session.meta.finished = true
}

export function reduceRunOutcome(
  session: ChatSession,
  n: ChatEvent & { kind: 'notification' },
  ctx: OutcomeContext,
  upsertMessage: UpsertMessage,
): boolean {
  const type = n.type
  const replaying = session.sync.replaying
  const d = (n.data ?? {}) as Record<string, unknown>
  if (type === 'run.outcome') {
    const outcome = parseRunOutcome(d)
    if (!outcome) return true
    const terminalRunId = n.runId ?? (typeof d.runId === 'string' ? (d.runId as string) : undefined)
    session.activeTurns = session.activeTurns.filter(
      (turn) => !!terminalRunId && turn.runId !== terminalRunId,
    )
    if (!n.runId || n.runId === session.run.activeRunId) session.run.activeRunId = undefined
    session.interaction.runningTools = []
    session.run.outcome = outcome
    session.run.outcomeRunId = terminalRunId
    if (outcome.feedback?.retention === 'history') {
      const previous = session.run.outcomeHistory ?? []
      session.run.outcomeHistory = [
        ...previous.filter(
          (entry) =>
            entry.runId !== terminalRunId || entry.outcome.reasonCode !== outcome.reasonCode,
        ),
        { ...(terminalRunId ? { runId: terminalRunId } : {}), outcome },
      ]
    }
    session.run.status = outcome.status === 'completed' ? 'ended' : outcome.status
    session.context.canResume = outcome.canResume
    session.run.error = outcome.feedback?.severity === 'error' ? outcome.feedback.title : undefined
    session.run.errorFact = undefined
    if (!replaying && outcome.feedback) session.run.retainUntil = undefined
    if (terminalRunId) {
      session.activeRun = {
        ...(session.activeRun?.runId === terminalRunId ? session.activeRun : {}),
        chatId: session.chatId,
        runId: terminalRunId,
        status:
          outcome.status === 'cancelled'
            ? 'paused'
            : outcome.status === 'completed'
              ? 'completed'
              : outcome.status,
        at: outcome.occurredAt,
        completedAt: outcome.occurredAt,
      }
    }
    if (session.activeMessageId && outcome.status !== 'completed') {
      const active = session.messagesById[session.activeMessageId]
      if (active && active.status === 'streaming') {
        active.status = outcome.status === 'failed' ? 'error' : 'paused'
      }
    }
    applyOutcomeResultData(session, d, replaying, ctx, upsertMessage)
    return true
  }

  if (type === 'done' || type === 'error') {
    const terminalRunId = n.runId ?? (typeof d.runId === 'string' ? (d.runId as string) : undefined)
    // New servers emit run.outcome first. Ignore the following compatibility
    // event so it cannot overwrite warning/paused semantics with legacy error.
    if (terminalRunId && session.run.outcomeRunId === terminalRunId) return true
    session.activeTurns = session.activeTurns.filter(
      (turn) => !!terminalRunId && turn.runId !== terminalRunId,
    )
    // run 结束：无 runId 或 runId 匹配当前活跃 run -> 清 activeRunId（与旧 routeNotification 一致）
    if (!n.runId || n.runId === session.run.activeRunId) session.run.activeRunId = undefined
    session.interaction.runningTools = []
    if (terminalRunId) {
      const completedAt =
        typeof d.completedAt === 'number'
          ? d.completedAt
          : typeof d.at === 'number'
            ? d.at
            : undefined
      session.activeRun = {
        ...(session.activeRun?.runId === terminalRunId ? session.activeRun : {}),
        chatId: session.chatId,
        runId: terminalRunId,
        status: type === 'error' ? 'failed' : d.canResume === true ? 'paused' : 'completed',
        ...(completedAt !== undefined ? { at: completedAt, completedAt } : {}),
      }
    }

    if (type === 'done') {
      session.run.error = undefined
      session.run.errorFact = undefined
      // finalMessage 幂等补全并 seal
      const fm = d.finalMessage as
        | {
            msgId: string
            role: 'assistant'
            content: string
            thinking?: string
            createdAt: number
            agentChatId?: string
            contextCompaction?: boolean
            contextCompactionTokens?: number
          }
        | undefined
      if (fm) {
        upsertMessage(session, {
          msgId: fm.msgId,
          role: 'assistant',
          content: fm.content,
          status: 'sealed',
          createdAt: fm.createdAt,
          agentChatId: fm.agentChatId ?? session.chatId,
          ...(fm.thinking ? { thinking: fm.thinking } : {}),
          ...(fm.contextCompaction ? { contextCompaction: true } : {}),
          ...(fm.contextCompactionTokens !== undefined
            ? { contextCompactionTokens: fm.contextCompactionTokens }
            : {}),
        })
        // done.finalMessage 是该轮权威结果；覆盖可能因丢帧而只包含前缀的流式文本。
        const sealed = session.messagesById[fm.msgId]
        if (sealed) {
          sealed.content = fm.content
          if (fm.thinking !== undefined) sealed.thinking = fm.thinking
          sealed.status = 'sealed'
          const mediaAssets = extractMediaUrls(sealed.content)
          if (mediaAssets.length > 0) sealed.mediaAssets = mediaAssets
        }
        if (session.activeMessageId === fm.msgId) session.activeMessageId = undefined
      }
      const canResume = typeof d.canResume === 'boolean' ? d.canResume : undefined
      session.run.status = canResume ? 'paused' : 'ended'
      if (!replaying) session.run.retainUntil = ctx.now + 20000
      if (typeof d.contextUsage === 'number') session.context.contextUsage = d.contextUsage
      if (!replaying && typeof d.serverNow === 'number') {
        session.context.serverClockOffsetMs = d.serverNow - ctx.now
      }
      if (typeof d.used === 'number') session.context.contextUsed = d.used
      if (typeof d.total === 'number') session.context.contextTotal = d.total
      if (d.contextBreakdown)
        session.context.contextBreakdown = d.contextBreakdown as ContextBreakdown
      if (typeof canResume === 'boolean') session.context.canResume = canResume
      if (d.finished === true) session.meta.finished = true
    } else {
      // legacy error 仍代表 failed；canResume 独立决定是否显示继续入口。
      // active 消息标 error，保留已到达的部分内容。
      const errorFact = structuredRunError(d, n.requestId ?? n.runId ?? `legacy:${session.chatId}`)
      session.run.status = 'failed'
      session.run.error = errorFact.message
      session.run.errorFact = errorFact
      session.run.outcome = legacyErrorOutcome(
        d,
        n.requestId ?? n.runId ?? `legacy:${session.chatId}`,
        ctx.now,
      )
      session.run.outcomeRunId = terminalRunId
      if (session.run.outcome.feedback?.retention === 'history') {
        const previous = session.run.outcomeHistory ?? []
        session.run.outcomeHistory = [
          ...previous.filter((entry) => entry.runId !== terminalRunId),
          {
            ...(terminalRunId ? { runId: terminalRunId } : {}),
            outcome: session.run.outcome,
          },
        ]
      }
      if (!replaying) session.run.retainUntil = ctx.now + 30000
      if (session.activeMessageId) {
        const am = session.messagesById[session.activeMessageId]
        if (am && am.status === 'streaming') am.status = 'error'
      }
      if (typeof d.canResume === 'boolean') session.context.canResume = d.canResume
    }
    return true
  }

  return false
}
