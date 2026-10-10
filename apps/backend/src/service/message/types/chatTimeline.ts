import type {
  ChatInputSubmitResponse,
  ChatTimelineGetRequest,
  TerminationFact as ProtocolTerminationFact,
  TurnCancelledNotificationData as ProtocolTurnCancelledNotificationData,
} from '@chery/protocol'
import type {
  ActiveRunFact,
  ExecutionEdgeFact,
  GenerationEntry,
  PendingInputSnapshot,
  RootTimelineSnapshot,
  TaskCatalogStatus,
  TaskLatestResult,
  TimelineNode,
  TreeControlState,
} from '../types.js'
import type { RuntimeProvenance } from '@/agent/runtimeResolver.js'

export interface ChatSendResponseData {
  chatId: string
  /** 本次消息所属运行；运行中的 send 返当前活跃 run，而不是新建一条空流。 */
  runId: string
  /** true 表示消息已入队，后续事件仍归属 runId。 */
  queued?: boolean
  /**
   * 本次 send 写入的 user message 主键（= messages.id）。
   * 前端 sendMessage 据此即时 push user prompt 到 stream.history（带 msgId），
   * 下次 chat.get reload 时按 msgId 去重，避免重复。
   * 缺省：旧消息写入早于本字段时为 undefined（前端按 role+createdAt 兜底）。
   */
  userMsgId?: string
}

/** Immediate acknowledgement for chat.input.submit. */
export type ChatInputSubmitResponseData = ChatInputSubmitResponse

export interface ChatTimelineGetRequestData extends ChatTimelineGetRequest {
  /** Legacy single-chat key. Root timeline clients should send rootChatId. */
  chatId?: string
  rootChatId?: string
  taskId?: string
  view?: 'conversation' | 'tree' | 'audit'
  /** Legacy 路径 = 字符串复合游标（createdAt/id 编码，chat.get 同构）；lite P1-② = number（orderKey 排他下界，返回 orderKey < before 的更早页）。 */
  before?: string | number
  limit?: number
  knownRevision?: number
}

export interface CanonicalSenseCall {
  id: string
  name: string
  arguments: string
  result?: string
  status?: 'pending' | 'accepted' | 'rejected'
  /** 工具调用的安全授权判定；按 call id 独立保存，旧数据可省略。 */
  security?: ToolAuthorization
}

export interface CanonicalMessage {
  id: string
  chatId: string
  runId?: string
  role: 'user' | 'assistant' | 'sense' | 'role'
  content: string
  thinking?: string
  createdAt: number
  updatedAt: number
  status: 'committed' | 'revoked'
  runtime?: RuntimeProvenance
  senseCalls?: CanonicalSenseCall[]
  origin?: { parentChatId?: string; childChatId?: string; spawnCallId?: string }
  /** 该消息是 wakeParent 注入的子返回（child_return 链接）。前端据此标 mergedView 从主轴过滤。 */
  childReturn?: boolean
}

export type TerminationFact = ProtocolTerminationFact

/**
 * 域侧安全判定：与协议镜像 TimelineSecurityFact 结构兼容。
 * 后端判定由 core/security 产出（含 config 派生的 category 枚举），wire 投递时天然兼容镜像类型。
 */
export type ToolAuthorization = import('@/core/security/rolePolicy.js').ToolAuthorization

export type TaskOverviewStatus = TaskCatalogStatus

export type TaskAgentOverviewStatus =
  'needs_user' | 'running' | 'paused' | 'failed' | 'completed' | 'idle'

export interface TaskAgentOverview {
  chatId: string
  role: string
  status: TaskAgentOverviewStatus
  currentStep?: string
  /** 当前活动步骤类型（标题栏会话状态条 icon 映射：model=思考动画 / tool=sense 图标）。activeStep 存在时透出。 */
  currentStepKind?: 'model' | 'tool'
  startedAt?: number
}

export interface TaskActivityEvent {
  id: string
  rootChatId: string
  chatId: string
  kind:
    | 'run_started'
    | 'model_started'
    | 'tool_started'
    | 'tool_completed'
    | 'agent_spawned'
    | 'agent_completed'
    | 'waiting_user'
    | 'resumed'
    | 'paused'
    | 'failed'
    | 'completed'
  label: string
  at: number
}

export interface TaskOverview {
  rootChatId: string
  taskKey: string
  taskId?: string
  presetId?: string
  preset?: string
  title: string
  /** 末条 user 消息（截断 ≤40，复用 preview 规范化）；无 user 消息时省略。 */
  lastUserPrompt?: string
  status: TaskOverviewStatus
  startedAt?: number
  updatedAt: number
  pendingCount: number
  hasFailure: boolean
  agents: TaskAgentOverview[]
  recentEvents: TaskActivityEvent[]
  originalChatId: string
  openChatId: string
  branchCount: number
  currentStep?: string
  latestResult?: TaskLatestResult
  unreadResult: boolean
  attentionKey: string
}

export interface ChatOverviewOpenRequestData {
  completedSince?: number
}

export interface ChatOverviewOpenResponseData {
  subscriptionId: string
  revision: number
  tasks: TaskOverview[]
}

export interface ChatOverviewCloseRequestData {
  subscriptionId: string
}

export interface ChatOverviewCloseResponseData {
  subscriptionId: string
  closed: boolean
}

export interface ChatTimelineGetResponseData {
  chatId: string
  revision: number
  /** knownRevision 短路（unchanged:true）时省略 */
  messages?: CanonicalMessage[]
  rootTimeline?: RootTimelineSnapshot
  nextCursor?: string
  /** root 路径请求 knownRevision >= 当前 revision 时为 true，此时无 messages/rootTimeline */
  unchanged?: boolean
}

export interface ChatTimelineGenerationGetRequestData {
  rootChatId: string
  /** 1-based，指向 GenerationEntry.index */
  generationIndex: number
}

export interface ChatTimelineGenerationGetResponseData {
  rootChatId: string
  generation: GenerationEntry
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
}

/**
 * chat.timeline.node.get（lite profile P0，canonical §3.6.3）：
 * lean 摘要的按需全文出口。低频、用户触发、只读；不改变 snapshot/patch 权威性。
 */
export interface ChatTimelineNodeGetRequestData {
  rootChatId: string
  nodeId: string
  /** 缺省 = 全部 section；提供 = 只返回指定段（未请求段省略字段）。 */
  sections?: Array<'content' | 'thinking' | 'toolCalls'>
  /** 长内容分段（字符 offset，作用 sections 内每个文本字段）；与 limit 搭配。 */
  offset?: number
  /** 单次返回的字符上限；单响应 ≤32KB（服务端硬保证，超限截断并附引用）。 */
  limit?: number
  /**
   * toolCalls 的结构化游标。callIndex 是 toolCalls 数组下标，offset 使用
   * JavaScript UTF-16 code unit；仅允许与 sections:['toolCalls'] 一起使用。
   */
  toolCursor?: ChatTimelineNodeToolCursor
}

export interface ChatTimelineNodeToolCursor {
  callIndex: number
  field: 'arguments' | 'result'
  offset: number
}

export type ChatTimelineNodePage =
  | {
      section: 'content' | 'thinking'
      offset: number
      /** 本帧实际返回的 JavaScript UTF-16 code unit 数。 */
      consumed: number
      /** 仅在仍有后续内容时存在；客户端必须使用它续拉。 */
      nextOffset?: number
    }
  | {
      section: 'toolCalls'
      cursor: ChatTimelineNodeToolCursor
      /** 当前 arguments/result 分片实际返回的 UTF-16 code unit 数。 */
      consumed: number
      /** 跨字段、跨调用连续续拉的服务端游标。 */
      nextCursor?: ChatTimelineNodeToolCursor
    }

export interface ChatTimelineNodeGetResponseData {
  rootChatId: string
  /** 完整 TimelineNode（非 lean）；未请求的 section 字段被省略。 */
  node: TimelineNode
  /** 分段信息：sections 内文本字段被 offset/limit 或 32KB 硬上限截断时携带。 */
  refs: Array<{ field: string; contentLength: number; contentHash: string }>
  /** 是否还有未返回的剩余内容（任一字段被截断即 true；客户端续拉调 offset）。 */
  hasMore: boolean
  /** 分页实际进度；lite 投影在最终帧预算收缩后重算。 */
  page?: ChatTimelineNodePage
}

export type TimelinePatchOperation =
  | { type: 'upsert'; message: CanonicalMessage }
  | { type: 'revoke'; messageId: string }
  | { type: 'remove'; messageId: string }

export type RootTimelinePatchOperation =
  | { type: 'upsert'; node: TimelineNode }
  | { type: 'revoke'; nodeId: string }
  | { type: 'remove'; nodeId: string }
  | { type: 'upsert-edge'; edge: ExecutionEdgeFact }
  | { type: 'remove-edge'; edgeId: string }
  | { type: 'upsert-run'; run: ActiveRunFact }
  | { type: 'remove-run'; chatId: string; runId: string }
  | { type: 'upsert-input'; input: PendingInputSnapshot }
  | { type: 'remove-input'; inputId: string }

export interface RootTimelinePatchData {
  rootChatId: string
  view: RootTimelineSnapshot['view']
  baseRevision: number
  revision: number
  operations: RootTimelinePatchOperation[]
  controlState?: TreeControlState
}

export interface TimelinePatchData {
  chatId: string
  baseRevision: number
  revision: number
  operations: TimelinePatchOperation[]
  rootPatch?: RootTimelinePatchData
  rootPatches?: RootTimelinePatchData[]
}

export interface TurnStartedNotificationData {
  turnId: string
  messageId: string
  runId?: string
  createdAt: number
}
export interface TurnDeltaNotificationData {
  turnId: string
  messageId: string
  channel: 'thinking' | 'content'
  offset: number
  delta: string
}
export interface TurnCompletedNotificationData {
  turnId: string
  messageId: string
  /** 模型轮次结束时间戳（ms）；旧事件可省略。 */
  completedAt?: number
}

export type TurnCancelledNotificationData = ProtocolTurnCancelledNotificationData

export interface InputUpdatedNotificationData {
  inputId: string
  clientMessageId?: string
  messageId?: string
  state: 'accepted' | 'started' | 'queued' | 'consumed' | 'cancelled' | 'rejected'
  queueSequence?: number
  content?: string
  acceptedAt?: number
  reason?: string
}

export interface RunUpdatedNotificationData {
  runId: string
  status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed'
  /** 本次状态变化时间戳（ms）；旧事件可省略。 */
  at?: number
  /** run 首次进入 running 的时间戳（ms）；仅首次 running 通知携带。 */
  startedAt?: number
}
