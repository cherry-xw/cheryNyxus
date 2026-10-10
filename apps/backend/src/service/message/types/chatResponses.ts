import type { QuestionStateSnapshotData } from './chatSnapshots.js'
import type {
  ActiveTurnSnapshot,
  ChatSendResponseData,
  ChatSessionSnapshotData,
  ChildControlTargetResult,
  CurrentStateData,
  TreeControlOperationStatus,
} from '../types.js'

export interface RuntimeSetResponseData {
  chatId: string
  brain: string
  senseGroup: string
  mcpServers: string[]
}

export interface ChatResumeResponseData {
  chatId: string
  /** 本次恢复所属运行。 */
  runId: string
  /** true 表示已有运行，未启动第二条恢复流。 */
  alreadyRunning?: boolean
}

export interface ChatSyncResponseData extends QuestionStateSnapshotData, ChatSessionSnapshotData {
  chatId: string
  latestSeq: number
  minSeq?: number
  /** 协议固定 false；超窗由消息合成事件直接回填。 */
  reset: boolean
  /** true 表示本次已用消息合成事件回填超窗淘汰的旧历史。 */
  backfilled?: boolean
}

export interface ChatStartSpawnResponseData extends ChatSendResponseData {
  /** Existing task had already completed, so no child run was started. */
  alreadyFinished?: boolean
  /** This request completed the child task; the frontend should finalize its pet as a ghost. */
  finished?: boolean
}

export interface SenseApprovalResponseData {
  approvalId: string
  action: string
}

export interface ChatAbortResponseData {
  chatId: string
  /** Tree-level pause identity. Present when commandId was supplied. */
  pauseId?: string
  status?: TreeControlOperationStatus
  /** 实际被中止的运行；chat 不在运行时省略。 */
  runId?: string
  /** 是否存在并中止了活跃运行。 */
  aborted: boolean
  /** 统一暂停语义：级联暂停的后代 chat 数（主 abort 时递归暂停所有后代）。 */
  cascaded?: number
  /** Per-target audit result. Present for CP8-aware clients. */
  results?: ChildControlTargetResult[]
}

/**
 * chat.attach 响应。继承 QuestionStateSnapshotData 让前端拿到的 snapshotSeq + pendingQuestionBatches
 * 与 chat.get / chat.sync 同源 — attach 不仅是「重定向成功」，也是 cursor 锚点：
 * 前端 applyCurrentState(…, true) 借此 resetChatSeq，把 chatSeq 推到此刻持久化的最新事件位。
 * 重连窗口（disconnect → reconnect）期间到达的事件由 attach 后的 chat.sync 补回。
 */
export interface ChatAttachResponseData extends QuestionStateSnapshotData {
  chatId: string
  /** run 是否仍在运行；false → 前端回落历史，不重连实时流。 */
  running: boolean
  /** 当前运行标识；可能早于首个 assistant turn 出现。 */
  runId?: string
  /** 已产生的当前未完成回复，一次性恢复，禁止客户端重放历史 turn.delta 拼装。 */
  activeTurns: ActiveTurnSnapshot[]
  /** running 时是否已完成输出重定向到本连接。 */
  attached?: boolean
  /** 刷新当前态快照（running 时含存活的 pending approval / 运行中工具 / 当前 todo）。 */
  currentState?: CurrentStateData
}

/**
 * 挂起 bash 进程信息（bash.list 返回）。
 * 结构对齐 agent/sense/processRegistry.ts BashProcessEntry（service 层不反向依赖 agent，独立定义）。
 */
export interface BashProcessInfo {
  pid: number
  command: string
  description: string
  startedAt: number
  /** 是否已被显式 kill（区分自然结束）。 */
  killed: boolean
}

export interface BashKillResponseData {
  chatId: string
  pid: number
  /** 是否命中注册表并发送了 kill 信号（false = 该 pid 已不在挂起表中）。 */
  killed: boolean
}

export interface BashListResponseData {
  chatId: string
  processes: BashProcessInfo[]
}
