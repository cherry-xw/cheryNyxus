/**
 * ChatSession 只读选择器（纯函数；不修改实体）。
 *
 * 消费层（Pet 气泡 / HistoryDrawer / SessionList / 工具栏）一律经 selector 读取，
 * 不直接访问 `messagesById`/`messageOrder`。群聊时间线由 selector 动态聚合 root+descendants，
 * 不把子消息复制进父实体（不变式 2）。
 *
 * 群聊合并复用 domain 中的纯 session-tree/history projection，通过 `toHistoryItem` 把规范 ChatMessage
 * 投影为 HistoryItem 供既有 MessageBubble 渲染（view，非第二存储）。
 */

import type { ChatSession, ChatMessage } from '../types'
import type { HistoryItem } from '@/domain/chat/projectionTypes'
import type { ContextBreakdown, CurrentStateData, RuntimeSelection } from '@/services/agentApi'
import { dedupHistoryByMsgId, mergeChildReplyHistory } from '@/domain/chat/historyProjection'
import { collectDescendantChatIds } from '@/domain/chat/sessionTree'

/** 取 session 自身消息（按 messageOrder；排除 revoked）。 */
export function selectMessages(session: ChatSession): ChatMessage[] {
  return session.messageOrder
    .map((id) => session.messagesById[id])
    .filter((m): m is ChatMessage => !!m && m.status !== 'revoked')
}

/** 当前 streaming 消息（Pet 气泡数据源）。无则 undefined。 */
export function selectActiveMessage(session: ChatSession): ChatMessage | undefined {
  if (!session.activeMessageId) return undefined
  const m = session.messagesById[session.activeMessageId]
  return m && m.status !== 'revoked' ? m : undefined
}

/** Pet 气泡视图：active 消息 thinking/content + run 错误/保留态。新 msgId 到达即重置（不变式 5）。 */
export interface BubbleView {
  thinking: string
  content: string
  status: ChatMessage['status'] | 'idle'
  error?: string
  retainUntil?: number
  isWorking: boolean
}

export function selectBubble(session: ChatSession): BubbleView {
  const active = selectActiveMessage(session)
  return {
    thinking: active?.thinking ?? '',
    content: active?.content ?? '',
    status: active?.status ?? (session.run.status === 'running' ? 'streaming' : 'idle'),
    error: session.run.error,
    retainUntil: session.run.retainUntil,
    isWorking: session.run.status === 'running',
  }
}

/** 工作态（Pet action/mood 数据源；run.status 权威）。 */
export function selectIsWorking(session: ChatSession): boolean {
  return session.run.status === 'running'
}

export function selectRunStatus(session: ChatSession): ChatSession['run']['status'] {
  return session.run.status
}

/**
 * 可显式继续（统一暂停语义：paused 显继续按钮；ended 无按钮）。
 * 显式三段（不 `??` 退化）：context.canResume 权威（后端 chat.list/chat.get 投影 +
 * 前端操作方维护），undefined 时才回退 run.status。stale false 会错误隐藏「继续」按钮。
 * 消费方（agents store / hydration）必须复用本函数，消除三处漂移（docs/web/pet/agent-integration.md）。
 */
export function resolveCanResume(session: ChatSession): boolean {
  return session.context.canResume !== undefined
    ? session.context.canResume
    : session.run.status === 'paused'
}
export const selectCanResume = resolveCanResume

/** 当前 runtime（ContextBar / AgentDialog 数据源）。 */
export function selectRuntime(session: ChatSession): RuntimeSelection | undefined {
  return session.context.runtime
}

export function selectContextUsage(session: ChatSession): number | undefined {
  return session.context.contextUsage
}

export function selectContextBreakdown(session: ChatSession): ContextBreakdown | undefined {
  return session.context.contextBreakdown
}

/** 当前态快照（pendingApproval/runningTools/currentTodo；currentState 权威）。 */
export function selectCurrentState(session: ChatSession): CurrentStateData | undefined {
  const s = session.interaction
  const approval = s.approval
  return {
    ...(approval
      ? {
          pendingApproval: {
            approvalId: approval.approvalId,
            senseName: approval.senseName,
            arguments:
              typeof approval.args === 'string'
                ? approval.args
                : JSON.stringify(approval.args ?? ''),
            supervisionLevel: 0,
            waitTime: approval.waitTime,
            createdAt: approval.createdAt,
          },
        }
      : {}),
    runningTools: s.runningTools.map((t) => ({ id: t.id, senseName: t.name })),
    executionSteps: session.executionSteps.map((step) => ({ ...step })),
    ...(session.activeRun?.runId && typeof session.activeRun.startedAt === 'number'
      ? {
          runTiming: {
            runId: session.activeRun.runId,
            startedAt: session.activeRun.startedAt,
          },
        }
      : {}),
    ...(s.currentTodo ? { currentTodo: s.currentTodo } : {}),
  }
}

export function selectApproval(session: ChatSession) {
  return session.interaction.approval
}

export function selectApprovalQueue(session: ChatSession) {
  return session.interaction.approvalQueue
}

export function selectQuestionBatches(session: ChatSession) {
  return session.interaction.questionBatches
}

export function selectActiveQuestionId(session: ChatSession): string | undefined {
  return session.interaction.activeQuestionId
}

export function selectRunningTools(session: ChatSession) {
  return session.interaction.runningTools
}

export function selectCurrentTodo(session: ChatSession): unknown[] | undefined {
  return session.interaction.currentTodo
}

/** hydration 是否完成（catalog 骨架 / 补全中 = false）。 */
export function selectLoaded(session: ChatSession): boolean {
  return session.sync.loaded
}

/** ChatMessage -> HistoryItem 投影（供既有 MessageBubble 渲染；view，非存储）。 */
export function toHistoryItem(msg: ChatMessage): HistoryItem {
  return {
    role: msg.role,
    content: msg.content,
    ...(msg.thinking ? { thinking: msg.thinking } : {}),
    ...(msg.senseCalls?.length ? { senseCalls: msg.senseCalls.map((c) => ({ ...c })) } : {}),
    ...(msg.mediaAssets?.length ? { mediaAssets: msg.mediaAssets.map((m) => ({ ...m })) } : {}),
    ...(msg.petName ? { petName: msg.petName } : {}),
    ...(msg.subPetChatId ? { subPetChatId: msg.subPetChatId } : {}),
    ...(msg.callerSubPetChatId ? { callerSubPetChatId: msg.callerSubPetChatId } : {}),
    ...(msg.mergedView ? { mergedView: msg.mergedView } : {}),
    ...(msg.spawnSenseCallId ? { spawnSenseCallId: msg.spawnSenseCallId } : {}),
    ...(msg.runtime ? { runtime: msg.runtime } : {}),
    createdAt: msg.createdAt,
    msgId: msg.msgId,
    agentChatId: msg.agentChatId,
    ...(msg.contextCompaction ? { contextCompaction: true } : {}),
    ...(msg.contextCompactionTokens !== undefined
      ? { contextCompactionTokens: msg.contextCompactionTokens }
      : {}),
    ...(msg.delivery
      ? {
          delivery: {
            status: msg.delivery.status,
            ...(msg.delivery.error ? { error: { ...msg.delivery.error } } : {}),
          },
        }
      : {}),
  }
}

/** 自身时间线（direct 视图：仅本 chat 消息，按 createdAt 排序，合并子回复折叠）。 */
export function selectOwnTimeline(session: ChatSession): HistoryItem[] {
  const items = selectMessages(session).map(toHistoryItem)
  return mergeChildReplyHistory(items.sort(byCreatedAt))
}

/**
 * 群聊时间线（group 视图：root + 全部后代消息聚合，按 createdAt 稳定排序，msgId 去重 + 子回复合并）。
 * 不修改任何实体；selector 动态聚合（不变式 2）。
 */
export function selectGroupTimeline(
  sessionsById: Record<string, ChatSession>,
  rootChatId: string,
): HistoryItem[] {
  const root = sessionsById[rootChatId]
  if (!root) return []
  const chats = Object.values(sessionsById).map((s) => ({
    chatId: s.chatId,
    parentChatId: s.meta.parentChatId,
  }))
  const descendantIds = collectDescendantChatIds(chats, rootChatId)
  const allIds = [rootChatId, ...descendantIds]

  const items: HistoryItem[] = []
  for (const id of allIds) {
    const s = sessionsById[id]
    if (!s) continue
    for (const m of selectMessages(s)) items.push(toHistoryItem(m))
  }
  return mergeChildReplyHistory(dedupHistoryByMsgId(items.sort(byCreatedAt)))
}

function byCreatedAt(a: HistoryItem, b: HistoryItem): number {
  const ca = a.createdAt ?? 0
  const cb = b.createdAt ?? 0
  if (ca !== cb) return ca - cb
  return (a.msgId ?? '').localeCompare(b.msgId ?? '')
}

export {
  FULL_EXECUTION_PRESENTATION,
  LITE_EXECUTION_PRESENTATION,
  selectExecutionReadModel,
} from './executionReadModel'
export type {
  ExecutionAgentActivity,
  ExecutionFinalResponse,
  ExecutionPresentationOptions,
  ExecutionQuestion,
  ExecutionReadModel,
  ExecutionReadModelSource,
  ExecutionReadStep,
  ExecutionRootStatus,
} from './executionReadModel'

/**
 * catalog 列表（SessionList 数据源）：所有 session 的 meta 投影为摘要，按 updatedAt 降序。
 * 打开零 RPC；点击未 hydrated root 才调 hydrateTree。
 */
export function selectCatalogList(
  sessionsById: Record<string, ChatSession>,
): Array<ChatSession['meta'] & { chatId: string; loaded: boolean }> {
  return Object.values(sessionsById)
    .map((s) => ({ ...s.meta, chatId: s.chatId, loaded: s.sync.loaded }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** 最近 N 个 root chatId（启动 hydration 范围计算用）。root = 无 parentChatId。 */
export function selectRecentRootIds(
  sessionsById: Record<string, ChatSession>,
  topN: number,
): string[] {
  return Object.values(sessionsById)
    .filter((s) => !s.meta.parentChatId)
    .sort((a, b) => (b.meta.updatedAt ?? 0) - (a.meta.updatedAt ?? 0))
    .slice(0, topN)
    .map((s) => s.chatId)
}

/**
 * nyxus 独立核心的「活跃」会话（root chat + preset=cheryNyxus）。
 * 多会话模型：优先返回 activeChatId 命中的会话；未命中或未指定则回退到最近一条（updatedAt 降序）。
 * 与 petLifecycle.getActiveNyxus 同源判定，作为 NyxusCore 脱离 pets[] 后的数据锚点。
 */
export function selectNyxusSession(
  sessionsById: Record<string, ChatSession>,
  activeChatId?: string | null,
): ChatSession | undefined {
  const nyxusSessions = Object.values(sessionsById).filter(
    (s) => !s.meta.parentChatId && s.meta.preset === 'cheryNyxus',
  )
  if (activeChatId) {
    const hit = nyxusSessions.find((s) => s.chatId === activeChatId)
    if (hit) return hit
  }
  return nyxusSessions.sort((a, b) => (b.meta.updatedAt ?? 0) - (a.meta.updatedAt ?? 0))[0]
}
