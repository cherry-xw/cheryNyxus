/**
 * ChatSession hydration 纯变换：catalog 工厂 + snapshot 权威替换。
 *
 * 异步 hydrate 内核（attach->sync RPC + wsClient cursor）在 [index.ts](./index.ts) store action 层，
 * 本文件仅提供确定性数据变换，便于单测与复用。
 *
 * 启动/加载/重连共用同一变换：snapshot 在 `snapshotSeq` 边界做权威 replace（currentState/question/context），
 * 边界后缓冲事件由 wsClient gap buffer 按 seq 排出再经 reducer 应用（见 [docs/web/pet/agent-integration.md](../../../../docs/web/pet/agent-integration.md)）。
 */

import type {
  ChatSession,
  ChatSessionSnapshot,
  ChatMetadata,
  ChatInteractionState,
} from './types'
import type { ChatSummary, CurrentStateData, RuntimeSelection } from '@/services/agentApi'
import { replaceQuestionBatches } from './reducer'

/** 默认空 session（catalog 骨架 / ensureEntity 用）。 */
export function createEmptySession(chatId: string, meta?: Partial<ChatMetadata>): ChatSession {
  return {
    chatId,
    meta: { chatId, ...meta },
    messagesById: {},
    messageOrder: [],
    run: { status: 'idle' },
    interaction: {
      approvalQueue: [],
      questionBatches: [],
      runningTools: [],
    },
    context: {},
    sync: { loaded: false, replaying: false, lastSeq: 0 },
    ui: { drawerOpen: false, autoScroll: true, bubbleVisible: false },
  }
}

/** chat.list 摘要 -> catalog 实体（未 hydration；meta 投影自 ChatSummary）。 */
export function createCatalogEntity(summary: ChatSummary): ChatSession {
  return createEmptySession(summary.chatId, {
    chatId: summary.chatId,
    parentChatId: summary.parentChatId ?? undefined,
    agentType: summary.agentType,
    avatar: summary.avatar,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    preview: summary.preview,
    turnCount: summary.turnCount,
    messageCount: summary.messageCount,
    finished: summary.finished,
    wake: summary.wake,
    preset: summary.preset,
    workspace: summary.workspace,
    workspaceValid: summary.workspaceValid,
  })
}

/**
 * currentState 权威 replace：pendingApproval -> approval 槽；runningTools/currentTodo 整体替换。
 * 快照只含最前一个 pending approval，故仅替换 approval 槽，不动 approvalQueue（队列由事件管理）。
 */
export function applyCurrentState(
  session: ChatSession,
  cs: CurrentStateData | undefined,
  now: number,
): void {
  const inter = session.interaction
  if (cs?.pendingApproval) {
    const pa = cs.pendingApproval
    inter.approval = {
      approvalId: pa.approvalId,
      senseName: pa.senseName,
      args: pa.arguments,
      waitTime: pa.waitTime,
      createdAt: pa.createdAt,
    }
  } else {
    inter.approval = undefined
  }
  inter.runningTools = (cs?.runningTools ?? []).map((t) => ({ id: t.id, name: t.senseName }))
  inter.currentTodo = cs?.currentTodo
  // currentState 携带 pending approval 意味 run 仍 running（非 paused）；无则 run 已停（done/error/park）
  // 不在此推断 run.status——run.status 由事件流（done/error）权威推进，避免快照与事件争抢。
  void now
}

/**
 * snapshot 权威替换（chat.get/sync/attach response）。
 * 在 snapshotSeq 边界：context / meta / currentState / question 全量 replace；sync.snapshotSeq 锚定。
 * 边界后事件由 reducer 增量应用。
 */
export function applySnapshot(
  session: ChatSession,
  snap: ChatSessionSnapshot,
  now: number,
): void {
  if (snap.meta) Object.assign(session.meta, snap.meta)
  if (snap.runtime) session.context.runtime = snap.runtime as RuntimeSelection
  if (snap.preset !== undefined) session.meta.preset = snap.preset
  if (snap.canResume !== undefined) session.context.canResume = snap.canResume
  if (typeof snap.contextUsage === 'number') session.context.contextUsage = snap.contextUsage
  if (typeof snap.contextUsed === 'number') session.context.contextUsed = snap.contextUsed
  if (typeof snap.contextTotal === 'number') session.context.contextTotal = snap.contextTotal
  if (snap.contextBreakdown) session.context.contextBreakdown = snap.contextBreakdown
  if (snap.commandConfig) session.context.commandConfig = snap.commandConfig
  if (snap.workspace !== undefined) session.meta.workspace = snap.workspace
  if (snap.workspaceValid !== undefined) session.meta.workspaceValid = snap.workspaceValid
  if (snap.currentState !== undefined) applyCurrentState(session, snap.currentState, now)
  if (snap.pendingQuestionBatches !== undefined) {
    replaceQuestionBatches(session.interaction as ChatInteractionState, snap.pendingQuestionBatches)
  }
  if (typeof snap.snapshotSeq === 'number') session.sync.snapshotSeq = snap.snapshotSeq
}

/**
 * sync 回放窗口标记：true=事件幂等累加 + 抑制实时副作用（done retainUntil/error-bubble/toast/
 * startSpawn/resumeAgent + stream chunk 累加进气泡）。回放期一律 true（含非运行 chat），
 * 回放结束（sync response 到达 + 边界后事件排空）清 false。
 */
export function setReplaying(session: ChatSession, replaying: boolean): void {
  session.sync.replaying = replaying
}

/** 标记 hydration 完成（sync.loaded）。 */
export function markLoaded(session: ChatSession, lastSeq: number): void {
  session.sync.loaded = true
  session.sync.lastSeq = lastSeq
}
