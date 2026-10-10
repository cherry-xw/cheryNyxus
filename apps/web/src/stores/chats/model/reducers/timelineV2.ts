import type { ChatSession, ChatMessage } from '../../types'
import type { SenseCallRecord } from '@/domain/chat/projectionTypes'
import type { CanonicalMessage, TimelinePatch, ActiveTurnSnapshot, PendingInput, RunSnapshot, ChatSessionEvent } from '@/services/agentApi'
import { applyExecutionTimingEvent } from '../../read-model/executionTiming'

interface ReduceContext { now: number }

/** reverse 撤回：按 messageIds 标 revoked（展示 selector 排除）。 */
export function reduceReverse(session: ChatSession, ids: string[]): void {
  const revokedIds = new Set(ids)
  for (const id of ids) {
    const msg = session.messagesById[id]
    if (msg) msg.status = 'revoked'
  }
  if (session.activeMessageId && revokedIds.has(session.activeMessageId)) {
    session.activeMessageId = undefined
  }
  session.activeTurns = session.activeTurns.filter(
    (turn) => !revokedIds.has(turn.messageId) && !revokedIds.has(turn.turnId),
  )
}

// ---- Protocol V2 timeline/session reducer ---------------------------------

/** Convert one backend canonical message to the existing render projection. */
function canonicalToChatMessage(m: CanonicalMessage, chatId: string): ChatMessage {
  const isChildOrigin = !!m.origin?.parentChatId && !!m.origin?.childChatId
  const role = isChildOrigin
    ? m.role === 'user'
      ? 'master'
      : m.role === 'assistant'
        ? 'role'
        : m.role === 'sense'
          ? 'assistant'
          : m.role
    : m.role === 'master'
      ? 'master'
      : m.role === 'sense'
        ? 'assistant'
        : m.role
  const senseCalls: SenseCallRecord[] = (m.senseCalls ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    args: c.arguments,
    result: c.result,
    status: (c.status === 'rejected'
      ? 'error'
      : c.status === 'pending'
        ? 'running'
        : 'done') as SenseCallRecord['status'],
    security: c.security,
  }))
  return {
    msgId: m.id,
    role,
    thinking: m.thinking ?? '',
    content: m.content ?? '',
    senseCalls,
    status: m.status === 'revoked' ? 'revoked' : 'sealed',
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    agentChatId: m.chatId || chatId,
    ...(m.runtime ? { runtime: m.runtime } : {}),
    ...(m.origin?.childChatId ? { subPetChatId: m.origin.childChatId } : {}),
    ...(m.origin?.parentChatId ? { callerSubPetChatId: m.origin.parentChatId } : {}),
    // child_return（子返回/超时注入）-> mergedView=child-to-master，分支树主轴过滤（与 live reducer 一致）。
    ...(m.childReturn ? { mergedView: 'child-to-master' as const } : {}),
  }
}

/** Replace the canonical timeline atomically. Returns the installed revision. */
export function replaceTimeline(
  session: ChatSession,
  snapshot: { chatId: string; revision: number; messages: CanonicalMessage[]; eventSeq?: number },
): number {
  // A failed/unknown local command has no durable timeline row yet. Preserve it
  // across reconnect hydration so the user can retry with the same commandId or
  // explicitly remove it instead of silently losing the draft.
  const recoverableOutgoing = session.messageOrder
    .map((id) => session.messagesById[id])
    .filter(
      (message): message is ChatMessage =>
        !!message?.delivery && message.delivery.status !== 'committed',
    )
  const byId: Record<string, ChatMessage> = {}
  const order: string[] = []
  for (const canonical of snapshot.messages ?? []) {
    if (!canonical?.id || byId[canonical.id]) continue
    const message = canonicalToChatMessage(canonical, session.chatId)
    byId[message.msgId] = message
    order.push(message.msgId)
  }
  for (const message of recoverableOutgoing) {
    if (byId[message.msgId]) continue
    byId[message.msgId] = message
    order.push(message.msgId)
  }
  session.messagesById = byId
  session.messageOrder = order
  session.activeMessageId = undefined
  session.pendingInputs = session.pendingInputs.filter((input) => {
    const id = input.messageId
    return !id || !byId[id] || byId[id]?.status === 'revoked'
  })
  // Timeline replacement must not erase the independent session-plane
  // snapshot. `chat.open` may have returned active turns at the same boundary;
  // they are updated only by turn.* events or a subsequent open.
  session.sync.timelineRevision = snapshot.revision
  if (typeof snapshot.eventSeq === 'number') {
    session.sync.eventSeq = snapshot.eventSeq
    session.sync.lastSeq = Math.max(session.sync.lastSeq, snapshot.eventSeq)
  }
  return snapshot.revision
}

/** Apply a revisioned patch; false means base revision gap and caller must refetch. */
export function applyTimelinePatch(session: ChatSession, patch: TimelinePatch): boolean {
  const current = session.sync.timelineRevision ?? 0
  if (patch.baseRevision !== current || patch.revision <= current) return false
  for (const operation of patch.operations ?? []) {
    if (operation.type === 'upsert' && operation.message?.id) {
      const message = canonicalToChatMessage(operation.message, session.chatId)
      if (!session.messagesById[message.msgId]) session.messageOrder.push(message.msgId)
      session.messagesById[message.msgId] = message
      session.pendingInputs = session.pendingInputs.filter((i) => i.messageId !== message.msgId)
      session.activeTurns = session.activeTurns.filter((t) => t.messageId !== message.msgId)
      if (session.activeMessageId === message.msgId) session.activeMessageId = undefined
    } else if (
      (operation.type === 'revoke' || operation.type === 'remove') &&
      operation.messageId
    ) {
      const existing = session.messagesById[operation.messageId]
      if (operation.type === 'revoke' && existing) existing.status = 'revoked'
      if (operation.type === 'remove') {
        delete session.messagesById[operation.messageId]
        session.messageOrder = session.messageOrder.filter((id) => id !== operation.messageId)
      }
      session.pendingInputs = session.pendingInputs.filter(
        (i) => i.messageId !== operation.messageId,
      )
      session.activeTurns = session.activeTurns.filter((t) => t.messageId !== operation.messageId)
    }
  }
  session.sync.timelineRevision = patch.revision
  if (typeof patch.eventSeq === 'number')
    session.sync.eventSeq = Math.max(session.sync.eventSeq ?? 0, patch.eventSeq)
  return true
}

function applyTurnDelta(session: ChatSession, event: ChatSessionEvent, ctx: ReduceContext): void {
  const data = (event.data ?? event) as Partial<ActiveTurnSnapshot> & {
    channel?: 'thinking' | 'content'
    offset?: number
    delta?: string
  }
  if (!data.turnId || !data.messageId || typeof data.delta !== 'string') return
  let turn = session.activeTurns.find((t) => t.turnId === data.turnId)
  if (!turn) {
    turn = {
      turnId: data.turnId,
      runId: data.runId,
      messageId: data.messageId,
      thinking: '',
      content: '',
      nextThinkingOffset: 0,
      nextContentOffset: 0,
      status: 'running',
      createdAt: data.createdAt,
    }
    session.activeTurns.push(turn)
  }
  const channel = data.channel === 'thinking' ? 'thinking' : 'content'
  const expected =
    channel === 'thinking'
      ? (turn.nextThinkingOffset ?? turn.thinkingOffset ?? turn.thinking.length)
      : (turn.nextContentOffset ?? turn.contentOffset ?? turn.content.length)
  const offset = typeof data.offset === 'number' ? data.offset : expected
  if (offset !== expected) {
    session.sync.resyncRequired = true
    return
  }
  turn[channel] += data.delta
  if (channel === 'thinking') turn.nextThinkingOffset = expected + data.delta.length
  else turn.nextContentOffset = expected + data.delta.length
  session.run.status = 'running'
  session.run.activeRunId = data.runId ?? session.run.activeRunId
  session.activeMessageId = data.messageId
  const active = session.messagesById[data.messageId]
  if (active) {
    active[channel] += data.delta
    active.updatedAt = ctx.now
    active.status = 'streaming'
  } else {
    session.messagesById[data.messageId] = {
      msgId: data.messageId,
      role: 'assistant',
      thinking: channel === 'thinking' ? data.delta : '',
      content: channel === 'content' ? data.delta : '',
      senseCalls: [],
      status: 'streaming',
      createdAt: data.createdAt ?? ctx.now,
      updatedAt: ctx.now,
      agentChatId: session.chatId,
    }
    session.messageOrder.push(data.messageId)
  }
}

/** 把 chat.open 的 active turn 快照投影回 canonical message，供树与 CRT 立即续显。 */
export function installActiveTurns(
  session: ChatSession,
  turns: ActiveTurnSnapshot[],
  now: number,
): void {
  for (const turn of turns) {
    if (!turn.messageId || turn.status === 'completed') continue
    const existing = session.messagesById[turn.messageId]
    if (existing) {
      existing.thinking = turn.thinking
      existing.content = turn.content
      existing.status = 'streaming'
      existing.updatedAt = now
    } else {
      session.messagesById[turn.messageId] = {
        msgId: turn.messageId,
        role: 'assistant',
        thinking: turn.thinking,
        content: turn.content,
        senseCalls: [],
        status: 'streaming',
        createdAt: turn.createdAt ?? now,
        updatedAt: now,
        agentChatId: session.chatId,
      }
      session.messageOrder.push(turn.messageId)
    }
    session.activeMessageId = turn.messageId
  }
}

/** Apply one V2 session event. Returns false for event-seq/revision gaps. */
export function reduceSessionEvent(
  session: ChatSession,
  event: ChatSessionEvent,
  ctx: ReduceContext,
): boolean {
  const currentSeq = session.sync.eventSeq ?? 0
  if (event.eventSeq <= currentSeq) return true
  if (event.eventSeq !== currentSeq + 1) {
    session.sync.resyncRequired = true
    return false
  }
  session.sync.eventSeq = event.eventSeq
  session.sync.lastSeq = Math.max(session.sync.lastSeq, event.eventSeq)
  // Both notification envelopes (`data: {...}`) and the compact V2 event
  // shape (fields at the top level) are accepted during protocol rollout.
  const data = (event.data && typeof event.data === 'object' ? event.data : event) as Record<
    string,
    unknown
  >
  const timingRunId =
    typeof data.runId === 'string'
      ? data.runId
      : typeof event.runId === 'string'
        ? event.runId
        : (session.activeRun?.runId ?? session.run.activeRunId)
  session.executionSteps = applyExecutionTimingEvent(session.executionSteps, {
    chatId: session.chatId,
    ...(timingRunId ? { runId: timingRunId } : {}),
    type: event.type,
    data,
  })
  switch (event.type) {
    case 'turn.started': {
      const turn = data as unknown as ActiveTurnSnapshot
      if (turn.turnId && !session.activeTurns.some((t) => t.turnId === turn.turnId)) {
        session.activeTurns.push({
          turnId: turn.turnId,
          runId: turn.runId,
          messageId: turn.messageId,
          thinking: turn.thinking ?? '',
          content: turn.content ?? '',
          nextThinkingOffset:
            turn.nextThinkingOffset ?? turn.thinkingOffset ?? turn.thinking?.length ?? 0,
          nextContentOffset:
            turn.nextContentOffset ?? turn.contentOffset ?? turn.content?.length ?? 0,
          status: 'running',
          createdAt: turn.createdAt,
        })
      }
      installActiveTurns(
        session,
        session.activeTurns.filter((item) => item.turnId === turn.turnId),
        ctx.now,
      )
      session.run.status = 'running'
      session.run.activeRunId = (turn as { runId?: string }).runId ?? session.run.activeRunId
      break
    }
    case 'turn.delta':
      applyTurnDelta(session, event, ctx)
      break
    case 'turn.cancelled': {
      const turnId = typeof data.turnId === 'string' ? data.turnId : undefined
      const messageId = typeof data.messageId === 'string' ? data.messageId : undefined
      session.activeTurns = session.activeTurns.filter(
        (turn) => turn.turnId !== turnId && turn.messageId !== messageId,
      )
      if (messageId) reduceReverse(session, [messageId])
      break
    }
    case 'turn.completed': {
      const turnId = typeof data.turnId === 'string' ? data.turnId : undefined
      const turn = session.activeTurns.find((t) => t.turnId === turnId)
      if (turn) turn.status = 'completed'
      session.activeTurns = session.activeTurns.filter((t) => t.turnId !== turnId)
      if (typeof data.messageId === 'string' && session.messagesById[data.messageId]) {
        session.messagesById[data.messageId]!.status = 'sealed'
        if (session.activeMessageId === data.messageId) session.activeMessageId = undefined
      }
      break
    }
    case 'input.updated': {
      const input = data as unknown as Partial<PendingInput>
      if (!input.inputId) break
      if (input.clientMessageId && input.messageId) {
        const optimistic = session.messageOrder
          .map((id) => session.messagesById[id])
          .find((message) => message?.delivery?.clientMessageId === input.clientMessageId)
        const optimisticId = optimistic?.msgId
        if (optimistic && optimisticId && input.messageId !== optimisticId) {
          optimistic.msgId = input.messageId
          session.messagesById[input.messageId] = optimistic
          if (optimisticId) delete session.messagesById[optimisticId]
          const messageIndex = session.messageOrder.indexOf(optimisticId)
          if (messageIndex >= 0) session.messageOrder[messageIndex] = input.messageId
        }
        if (optimistic?.delivery) {
          if (input.state === 'rejected' || input.state === 'cancelled') {
            optimistic.delivery.status = 'failed'
            optimistic.delivery.error = {
              code: input.state === 'rejected' ? 'INPUT_REJECTED' : 'INPUT_CANCELLED',
              message: input.reason ?? (input.state === 'rejected' ? '发送被拒绝' : '发送已取消'),
              source: 'chat',
              retryable: input.state === 'rejected',
              tracingId: `input:${input.inputId}`,
            }
          } else {
            optimistic.delivery.status = 'committed'
            delete optimistic.delivery.error
          }
        }
      }
      const existing = session.pendingInputs.find((i) => i.inputId === input.inputId)
      if (existing) Object.assign(existing, input)
      else if (input.messageId && input.clientMessageId && input.state) {
        session.pendingInputs.push(input as PendingInput)
      }
      break
    }
    case 'run.updated': {
      const incomingRun = data as unknown as RunSnapshot
      session.activeRun = {
        ...(session.activeRun?.runId === incomingRun.runId ? session.activeRun : {}),
        ...incomingRun,
      }
      const status = session.activeRun.status ?? session.activeRun.state
      const live = status === 'running' || status === 'waiting'
      session.run.status = live ? 'running' : status === 'paused' ? 'paused' : 'ended'
      if (live) session.run.activeRunId = session.activeRun.runId
      else {
        const terminalRunId = session.activeRun.runId
        session.activeTurns = session.activeTurns.filter((turn) => turn.runId !== terminalRunId)
        session.run.activeRunId = undefined
      }
      break
    }
    case 'timeline.patch':
      if (!applyTimelinePatch(session, data as unknown as TimelinePatch))
        session.sync.resyncRequired = true
      break
    default:
      break
  }
  return !session.sync.resyncRequired
}
