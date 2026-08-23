/**
 * ChatSession 单一数据层类型契约（canonical per-chatId 实体）。
 *
 * 设计目标见 [docs/web/pet/agent-integration.md](../../../../docs/web/pet/agent-integration.md)：
 * - 每个 chatId 只对应一个 `ChatSession`；所有领域写入只经 reducer（`applyEvent`）或快照替换（`replaceSnapshot`）。
 * - Pet 气泡与 HistoryDrawer 共享同一 `ChatMessage`（`messagesById` 唯一实例），实时打字机即同一消息 delta 持续更新。
 * - 主/子群聊时间线由 selector 动态聚合，不把子消息复制进父实体。
 * - 消息唯一轴 = `msgId`（= 后端 messages.id；checkpoint 在每轮 LLM turn 开始时预分配）。
 *
 * 复用既有协议类型，不重复定义：`SenseCallRecord`/`ApprovalState`/`QuestionBatchState`/`RunningTool`
 * 来自 [../agents/types](../agents/types.ts)；`RuntimeSelection`/`ContextBreakdown`/`CurrentStateData`/`ChatSummary`
 * 来自 [@/services/agentApi](../../../services/agentApi.ts)。
 */

import type {
  ContextBreakdown,
  CurrentStateData,
  RuntimeSelection,
  ChatSummary,
  CanonicalMessage,
  TimelinePatch,
  PendingInput,
  ActiveTurnSnapshot,
  RunSnapshot,
  ChatSessionEvent,
  ExecutionStep,
} from '@/services/agentApi'
import type {
  SenseCallRecord,
  MediaAssetRef,
  ApprovalState,
  QuestionBatchState,
  RunningTool,
  StreamChunkData,
  StagedChunkData,
  ChunkMessage,
  NotificationMessage,
} from '../agents/types'
import type { QuestionBatchPayload } from '../agents/actions/questionBatch'

/** 协议命令配置投影（镜像后端 CommandConfigData；camelCase）。 */
export interface CommandConfigData {
  warn: { usage: number; compact: boolean }
  auto: { usage: number; compact: boolean }
  minContextLimit: number
}

/**
 * 规范化消息（Pet 气泡 + HistoryDrawer 共享同一实例）。
 * - `streaming`：active，正在接收 delta（`activeMessageId` 指向它）。
 * - `sealed`：done/finalized，落定进历史。
 * - `paused`：run 中途 abort/park，保留已到达部分，可 resume 续写。
 * - `error`：本轮以错误结束（红边气泡）；run 层仍可 canResume 重试。
 * - `revoked`：reverse 撤回，展示 selector 排除。
 */
export interface ChatMessage {
  msgId: string
  role: 'user' | 'assistant' | 'role' | 'master'
  thinking: string
  content: string
  senseCalls: SenseCallRecord[]
  status: 'streaming' | 'sealed' | 'paused' | 'error' | 'revoked'
  createdAt: number
  updatedAt: number
  /** 消息来源 chatId（user/assistant=当前 chat；role reply=子 chat）。反向溯源用。 */
  agentChatId: string
  /** user=发送时配置；assistant=前一条 user runtime（后端关联）。缺失显「-」。 */
  runtime?: RuntimeSelection
  /** content 内嵌媒体资产（从 `/api/media/<filename>` URL 解析）。 */
  mediaAssets?: MediaAssetRef[]
  /** 此 assistant 消息是 /compact 生成的上下文摘要。 */
  contextCompaction?: boolean
  /** 该次压缩释放的估算 token 数，历史分割线提示。 */
  contextCompactionTokens?: number
  /** role 消息标注的 pet name（注入式=agentType；其余 UI 查 pets）。 */
  petName?: string
  /** master/role 合并式关联的子 pet chatId；UI 据此查真实 face/name。 */
  subPetChatId?: string
  /** 上层 sub pet chatId（多级 spawn 时 B 被 A 唤起 -> callerSubPetChatId = A.chatId）。 */
  callerSubPetChatId?: string
  /** 该消息是合并产物（HistoryDrawer mergeChildReplyHistory 写入；渲染层据此切分支）。 */
  mergedView?: 'child-to-master'
  /** spawn sense call id（role_reply notification 可携带；跳到触发该角色的工具调用用）。 */
  spawnSenseCallId?: string
}

/** chat 元数据（catalog 与 hydrated 实体共享；来自 ChatSummary）。 */
export interface ChatMetadata {
  chatId: string
  parentChatId?: string | null
  agentType?: string
  avatar?: string
  createdAt?: number
  updatedAt?: number
  /** 仅 catalog 实体携带（includePreview=true）；hyrated 后仍保留作 SessionList 渲染。 */
  preview?: string
  turnCount?: number
  messageCount?: number
  /** 子 agent 是否已完成（metadata.finished）；前端据此重建子 pet 为 ghost。 */
  finished?: boolean
  /** chat 当前是否正在运行（chat.list 返回；前端据此判断子 agent 存活、主 chat 是否卡死）。 */
  running?: boolean
  /** 子 chat 唤醒策略（metadata.wake）。主 chat 恒 undefined。 */
  wake?: 'immediate' | 'deferred' | 'barrier'
  /** 主 chat 创建时所选预设。 */
  preset?: string
  /** 当前 chat 关联工作目录（metadata.workspace 快照）。 */
  workspace?: string
  workspaceValid?: boolean
}

/** 单次 send/resume 运行状态（权威工作态；Pet 只读 selector）。 */
export interface ChatRunState {
  status: 'idle' | 'running' | 'paused' | 'ended'
  /** 当前 send/resume 运行 id；abort 定向到仍在执行的那一轮。 */
  activeRunId?: string
  /** done 后气泡保留到期时间戳（ms）；过期隐藏；新消息/abort 清除；hover 期间保持。 */
  retainUntil?: number
  /** 流式错误文案（error-bubble 红）；run 仍可 canResume 重试。 */
  error?: string
}

/** 交互态：审批 / 问题 / 运行中工具 / todo（currentState 权威 replace；事件按 id 幂等增删）。 */
export interface ChatInteractionState {
  /** 当前 pending 审批（无则 undefined）。用户关闭时移到 approvalQueue。 */
  approval?: ApprovalState
  /** 已隐藏但未处理的审批队列（PetIcons 右侧闪烁 icon；点击重新唤起）。 */
  approvalQueue: ApprovalState[]
  /** 后端权威 pending 问题批次；快照 replace 写入，事件按 batchId 幂等增删。 */
  questionBatches: QuestionBatchState[]
  /** 当前用户查看/编辑的 questionId（null=无选中不显 QuestionCard）。 */
  activeQuestionId?: string
  /** 运行中工具（sense_started push；accept 按 id 移除；done/error 清空）。 */
  runningTools: RunningTool[]
  /** 当前 todo（currentState.currentTodo 权威写入；TodoPanel 直读，不再反向扫描历史）。 */
  currentTodo?: unknown[]
}

/** 上下文与配置态（chat.get/sync/attach snapshot + done notification 增量）。 */
export interface ChatContextState {
  runtime?: RuntimeSelection
  canResume?: boolean
  contextUsage?: number
  contextUsed?: number
  contextTotal?: number
  contextBreakdown?: ContextBreakdown
  commandConfig?: CommandConfigData
  /** workspace 已在 metadata；此处不重复，ContextBar 直读 meta。 */
}

/** 同步/回放态（hydration 内核维护；唯一 cursor 所有者仍是 wsClient）。 */
export interface ChatSyncState {
  /** 是否已完成 hydration（sync.loaded）；false=catalog 骨架/补全中。 */
  loaded: boolean
  /** 回放期标记（chat.sync 期间 true，回放结束清）。true=事件幂等累加 + 抑制实时副作用。 */
  replaying: boolean
  /** 当前已应用到的 chat event seq（= wsClient.chatSeq 镜像；gap buffer 在 ws 层）。 */
  lastSeq: number
  /** 最近一次 snapshot replace 的 seq 边界；边界后缓冲事件按 seq 应用。 */
  snapshotSeq?: number
  /** V2 event cursor. Kept alongside legacy seq until the transport migration is complete. */
  eventSeq?: number
  /** V2 timeline revision; unlike eventSeq it advances only after DB commit. */
  timelineRevision?: number
  /** V2 subscription id returned by chat.open. */
  subscriptionId?: string
  /** Whether a gap was detected and a snapshot refresh is required. */
  resyncRequired?: boolean
}

/** UI 扩展态（纯前端；不进入领域真值）。 */
export interface ChatUiState {
  /** HistoryDrawer 是否展开。 */
  drawerOpen: boolean
  /** 用户是否停留在历史底部（true=新 delta 自动滚动跟随；手动上滚后 false 不抢视口）。 */
  autoScroll: boolean
  /** Pet 气泡是否可见（hover/working 期间保持）。 */
  bubbleVisible: boolean
}

/** 单 chat 规范化实体（唯一前端 UI 会话投影）。 */
export interface ChatSession {
  chatId: string
  meta: ChatMetadata
  messagesById: Record<string, ChatMessage>
  messageOrder: string[]
  /** 当前 streaming 消息指针；实时消息本身只存于 messagesById 一次。 */
  activeMessageId?: string
  run: ChatRunState
  interaction: ChatInteractionState
  context: ChatContextState
  sync: ChatSyncState
  ui: ChatUiState
  /** V2 transient session plane. Canonical timeline remains messagesById/messageOrder. */
  pendingInputs: PendingInput[]
  activeTurns: ActiveTurnSnapshot[]
  activeRun?: RunSnapshot
  /** 当前/最近一次 run 的计时步骤；来自 currentState/chat.open 或实时事件。 */
  executionSteps: ExecutionStep[]
}

/**
 * `replaceSnapshot` 入参：chat.get / chat.sync / chat.attach response 的权威快照。
 * 镜像后端 `ChatSessionSnapshotData` + `QuestionStateSnapshotData` + list 摘要。
 */
export interface ChatSessionSnapshot {
  chatId: string
  meta?: Partial<ChatMetadata>
  runtime?: RuntimeSelection
  preset?: string
  canResume?: boolean
  currentState?: CurrentStateData
  contextUsage?: number
  contextUsed?: number
  contextTotal?: number
  contextBreakdown?: ContextBreakdown
  commandConfig?: CommandConfigData
  workspace?: string
  workspaceValid?: boolean
  /** question 快照：snapshotSeq 边界 + pending 批次（payload 形，replaceQuestionBatches 转换）。 */
  snapshotSeq?: number
  pendingQuestionBatches?: QuestionBatchPayload[]
}

/** V2 timeline snapshot is intentionally separate from the legacy session snapshot. */
export interface ChatTimelineSnapshot {
  chatId: string
  revision: number
  messages: CanonicalMessage[]
  nextCursor?: string
  eventSeq?: number
}

export type ChatTimelinePatch = TimelinePatch
export type ChatEventV2 = ChatSessionEvent

/** WS 事件统一入口类型（chunk + notification 共用 applyEvent）。 */
export type ChatEvent =
  | ({ kind: 'chunk' } & ChunkMessage)
  | ({ kind: 'notification' } & NotificationMessage)
  | ({ kind: 'session' } & ChatSessionEvent)

/** 实时 stream delta data（别名，语义明确）。 */
export type { StreamChunkData, StagedChunkData }

/**
 * catalog 实体工厂入参（启动 chat.list 后建骨架，未 hydration）。
 * 从 ChatSummary 投影 meta；其余字段置默认。
 */
export interface CatalogEntityInput {
  summary: ChatSummary
}
