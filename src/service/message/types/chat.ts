import type {
  ConversationBranchKind as ProtocolConversationBranchKind,
  TreeControlOperationStatus as ProtocolTreeControlOperationStatus,
  TreeControlTargetStatus as ProtocolTreeControlTargetStatus,
  TreeControlTarget as ProtocolTreeControlTarget,
  TreeControlState as ProtocolTreeControlState,
  PendingInputSnapshot as ProtocolPendingInputSnapshot,
  ConversationBranchSummary as ProtocolConversationBranchSummary,
  TimelineActor as ProtocolTimelineActor,
  TimelineDirection as ProtocolTimelineDirection,
  TodoPlanItem as ProtocolTodoPlanItem,
  TodoPlanSnapshot as ProtocolTodoPlanSnapshot,
  TodoPlanRef as ProtocolTodoPlanRef,
  GraphToolCall as ProtocolGraphToolCall,
  ExecutionEdgeKind as ProtocolExecutionEdgeKind,
  ExecutionEdgeFact as ProtocolExecutionEdgeFact,
  ActiveRunFact as ProtocolActiveRunFact,
  GenerationEntry as ProtocolGenerationEntry,
  TimelineNode as ProtocolTimelineNode,
  RootTimelineSnapshot as ProtocolRootTimelineSnapshot,
  ChatInputSubmitRequest,
  ChatOpenRequest,
  ChatOpenResponse,
} from '@chery/protocol'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import type { CurrentStateData, PendingQuestionBatchData, ExecutionStep } from '../types.js'
import type { ChatInputSubmitResponseData } from './chatTimeline.js'

export interface ChatCreateRequestData {
  chatId?: string
  /** 预设名（T6）：给出则从 config.presets[preset].leader 解析编制（取 config.roles[leader] 的 brain/senseGroup/mcp/systemPrompt 锁定快照），忽略下方 brain/senseGroup */
  preset?: string
  /** 非预设路径必填；预设给出时忽略 */
  brain?: string
  senseGroup?: string
  /** 启用的 MCP server 名（绕过 sense_groups，其全部 tools 合并进 schema）。缺省 []。 */
  mcpServers?: string[]
  /** 角色（子 pet）关联主 chat 的 chatId；主 chat 不携带（DB 存 NULL）。主从 Agent 桌宠系统 CP1。 */
  parentChatId?: string
  /**
   * 空白复用检查开关（默认 false = 启用检查）：仅预设路径 + 主 chat + 未显式指定 chatId 时生效。
   * 启用时后端先查同预设 root 会话中无任何 user 消息（turnCount===0）者，命中直接返回其 chatId
   * （不新建，响应带 reused:true）；置 true 显式关闭检查，强制新建。
   */
  skipBlankReuse?: boolean
}

export interface ChatListRequestData {
  /** stage=当前舞台；preset=用户打开的预设；history=显式历史列表。 */
  scope: 'stage' | 'preset' | 'history'
  /** preset scope 优先使用稳定 id；旧记录可用名称回退。 */
  presetId?: string
  preset?: string
  /** 仅显式历史/预设目录需要首条消息预览。 */
  includePreview?: boolean
  /**
   * 仅 preset scope 生效的分页：返回条数上限（1-100，非法值拒绝）。
   * 缺省 = 全量返回（现有调用不变）；preset scope 同时排除非 original 分支 root（与前端 isPianoRootSession 对齐）。
   */
  limit?: number
  /** 仅 preset scope 生效的分页偏移；须 ≥0。 */
  offset?: number
}

export type TaskCatalogStatus =
  'idle' | 'needs_user' | 'running' | 'paused' | 'stopped' | 'failed' | 'completed'

export type TaskResultStatus = 'paused' | 'stopped' | 'failed' | 'completed'

export interface TaskSearchMatch {
  source: 'title' | 'user_prompt' | 'result'
  text: string
  highlights: Array<{ start: number; end: number }>
  branchChatId?: string
}

export interface TaskLatestResult {
  resultId: string
  status: TaskResultStatus
  completedAt: number
  content?: string
}

export interface TaskCatalogItem {
  taskKey: string
  taskId?: string
  originalChatId: string
  openChatId: string
  title: string
  lastUserPrompt?: string
  status: TaskCatalogStatus
  currentStep?: string
  latestResult?: TaskLatestResult
  unreadResult: boolean
  attentionKey: string
  createdAt: number
  updatedAt: number
  branchCount: number
  matches: TaskSearchMatch[]
}

export interface ChatTaskListRequestData {
  presetId?: string
  preset?: string
  query?: string
  statuses?: TaskCatalogStatus[]
  updatedFrom?: number
  updatedTo?: number
  sort?: 'updated_desc' | 'created_desc' | 'relevance'
  limit?: number
  cursor?: string
}

export interface ChatTaskListResponseData {
  items: TaskCatalogItem[]
  total: number
  snapshotAt: number
  nextCursor?: string
}

export interface ChatTaskResultViewRequestData {
  taskKey: string
  resultId: string
}

export interface ChatTaskResultViewResponseData {
  taskKey: string
  resultId: string
  viewed: boolean
  viewedAt?: number
  latestResultId?: string
}

export interface ChatRouteSuggestRequestData {
  presetId: string
  draft: string
  requestVersion: number
}

export interface ChatRouteTargetData {
  chatId: string | null
  confidence: number
  reason: string
}

export interface ChatRouteContextCandidateData {
  chatId: string
  preview: string
  lastUserActivityAt: number
}

export interface ChatRouteTraceData {
  context: {
    draft: string
    candidates: ChatRouteContextCandidateData[]
  }
  response: {
    content?: string
    toolCall: {
      name: 'select_conversation'
      arguments: ChatRouteTargetData
    }
  }
}

export interface ChatRouteSuggestResponseData {
  requestVersion: number
  target: ChatRouteTargetData
  trace: ChatRouteTraceData
}

/** 会话路由 Shadow 流式增量（实时 thinking/content，供前端路由小窗渲染）。 */
export interface RouteDeltaData {
  thinking: string
  content: string
}

/** 会话路由 Shadow 流式 chunk：delta=进行中；无 delta 即最终结果（= ChatRouteSuggestResponseData）。 */
export type RouteChunkData = { delta: RouteDeltaData } | ChatRouteSuggestResponseData

export interface ChatGetRequestData {
  chatId: string
}

export interface ChatContextUsageRequestData {
  chatId: string
}

export interface ChatDeleteRequestData {
  chatId: string
}

// ---- wire 事实类型（单一事实源在 @chery/protocol/timeline；此处别名转发保持既有 import 路径） ----

export type ConversationBranchKind = ProtocolConversationBranchKind

export type TreeControlOperationStatus = ProtocolTreeControlOperationStatus

export type TreeControlTargetStatus = ProtocolTreeControlTargetStatus

export type TreeControlTarget = ProtocolTreeControlTarget

export type TreeControlState = ProtocolTreeControlState

export type PendingInputSnapshot = ProtocolPendingInputSnapshot

export type ConversationBranchSummary = ProtocolConversationBranchSummary

export type TimelineActor = ProtocolTimelineActor

export type TimelineDirection = ProtocolTimelineDirection

export type TodoPlanItem = ProtocolTodoPlanItem

export type TodoPlanSnapshot = ProtocolTodoPlanSnapshot

export type TodoPlanRef = ProtocolTodoPlanRef

export type GraphToolCall = ProtocolGraphToolCall

export type ExecutionEdgeKind = ProtocolExecutionEdgeKind

export type ExecutionEdgeFact = ProtocolExecutionEdgeFact

export type ActiveRunFact = ProtocolActiveRunFact

export type GenerationEntry = ProtocolGenerationEntry

export type TimelineNode = ProtocolTimelineNode

export type RootTimelineSnapshot = ProtocolRootTimelineSnapshot

export interface BranchSideEffect {
  nodeId: string
  callId: string
  toolName: string
  arguments: string
  result?: string
}

export interface ChatBranchPreviewRequestData {
  rootChatId: string
  anchorNodeId: string
}
export interface ChatBranchPreviewResponseData {
  taskId: string
  sourceBranchId: string
  eligible: boolean
  reason?: string
  sideEffects: BranchSideEffect[]
  effectDigest: string
  inheritedCompletedTasks: BranchInheritedTask[]
  inheritedPausedTasks: BranchInheritedTask[]
}
export interface BranchInheritedTask {
  taskId: string
  childChatId: string
  parentChatId: string
  type: string
  status: 'pending' | 'started' | 'finished' | 'timed_out' | 'abandoned'
  content?: string
}
export interface ChatBranchCreateRequestData {
  rootChatId: string
  anchorNodeId: string
  branchType: 'continuation' | 'detail'
  prompt: string
  commandId: string
  clientMessageId: string
  messageId: string
  effectDigest?: string
}
export interface ChatBranchCreateResponseData extends ConversationBranchSummary {
  input: ChatInputSubmitResponseData
}
export interface ChatAbortTaskRequestData {
  taskId: string
  commandId: string
}
export interface ChatAbortTaskResponseData {
  taskId: string
  abortedBranches: string[]
}
export interface ChatBranchActivateRequestData {
  branchId: string
  commandId: string
}
export interface ChatBranchActivateResponseData {
  taskId: string
  activeBranchId: string
  activeChatId: string
  deliveryGeneration: number
}

/**
 * chat.send 入参
 * - prompt：用户文本（与 attachments 并存；纯文本 prompt 也允许）
 * - attachments：上传到 `/api/media/upload` 后的资产引用数组（结构化协议，替代旧的 `[[media:filename]]` 文本标记）。
 *   后端 chatMiddleware enrichMediaInputs 据 assetId 走 readMediaAsset → provider 多模态 buildMessages。
 *   旧文本 marker 仍兼容（旧 marker = 历史消息遗留；新客户端不再发 marker）。
 *   资产未通过 brain.capabilities.input[kind] 检查时不下发，附文本提示。
 */
export interface ChatSendRequestData {
  chatId: string
  prompt: string
  attachments?: ChatSendAttachment[]
  /** Internal command-plane handoff; legacy clients must omit these fields. */
  inputMeta?: { inputId?: string; messageId?: string; clientMessageId?: string; commandId?: string }
  inputAlreadyQueued?: boolean
}

/** V2 command-plane input submission. commandId is an idempotency key and
 * clientMessageId is generated by the caller for optimistic UI correlation. */
export type ChatInputSubmitRequestData = Omit<ChatInputSubmitRequest, 'attachments'> & {
  attachments?: ChatSendAttachment[]
  /** Internal-only authorization marker. The websocket schema intentionally strips it. */
  controlRootChatId?: string
}

export type ChatAttachmentKind = 'image' | 'video' | 'audio'

export interface ChatSendAttachment {
  /** 上传后服务端生成的 asset id（与 /api/media/upload 返回 UploadedMediaAsset.id 对应）。 */
  assetId: string
  kind: ChatAttachmentKind
  mimeType: string
}

export interface RuntimeSetRequestData {
  chatId: string
  brain: string
  /** 非预设 chat 必填；preset chat 下仅 brain 生效（编制锁定，强制取创建快照，显式带不同值 fail loud） */
  senseGroup?: string
  /** 启用的 MCP server 名。缺省 []（关闭所有 MCP）。preset chat 下锁定。 */
  mcpServers?: string[]
  /** 思考等级临时覆盖（可选）：缺省用大脑配置默认档位。 */
  thinking?: import('@/core/llm/adapter.js').ThinkingLevel
}

/** 当前会话临时编制：仅保存在服务进程内存，不写 chats.metadata。 */
export interface SessionRuntimeSetRequestData {
  chatId: string
  /** 主角色本轮及后续本次会话发送所用编制。 */
  primary: RuntimeSelection
  /** role type → 临时编制；后续 spawn_role 创建子角色时应用。 */
  roles: Record<string, RuntimeSelection>
}

/**
 * session.runtime.set 响应：
 * - applied：已立即切换并持久化到子 chat metadata.runtime 的子 chatId 列表（idle/未加载子）。
 * - deferredRunning：正在运行的子 chatId 列表，需用户先 abort→resume 后才生效（fail-loud）。
 */
export interface SessionRuntimeSetResponseData {
  chatId: string
  applied: string[]
  deferredRunning: string[]
}

export interface ChatResumeRequestData {
  chatId: string
}

export interface ChatResumeTreeRequestData {
  rootChatId: string
  pauseId: string
  commandId: string
}

export interface ChatResumeTreeResponseData {
  rootChatId: string
  pauseId: string
  commandId: string
  status: TreeControlOperationStatus
  results: TreeControlTarget[]
}

/** Replays recoverable chat events newer than afterSeq. */
export interface ChatSyncRequestData {
  chatId: string
  afterSeq: number
}

/** Atomic session subscription open. */
export type ChatOpenRequestData = ChatOpenRequest

export interface ActiveTurnSnapshot {
  /** Present for root snapshots so one flat list can cover every descendant. */
  chatId?: string
  turnId: string
  messageId: string
  runId?: string
  thinking: string
  content: string
  thinkingOffset: number
  contentOffset: number
  nextThinkingOffset?: number
  nextContentOffset?: number
  createdAt: number
}

export interface RunStateSnapshot {
  runId: string
  state: 'running' | 'paused' | 'completed' | 'failed'
  /** 从持久 run.updated 重建，供断线后恢复顶部总计时。 */
  startedAt?: number
}

export interface ChatOpenStateSnapshot {
  chatIds?: string[]
  run?: RunStateSnapshot
  runs?: Array<RunStateSnapshot & { chatId: string }>
  pendingInputs: PendingInputSnapshot[]
  activeTurns: ActiveTurnSnapshot[]
}

export interface ChatOpenResponseData extends ChatOpenResponse<
  ChatOpenStateSnapshot,
  RootTimelineSnapshot
> {
  chatId: string
  subscriptionId: string
  eventSeq: number
  timelineRevision: number
  timelineChanged: boolean
  /** root 路径 knownTimelineRevision 短路时为 true，此时省略 rootTimeline */
  timelineUnchanged?: boolean
  rootTimeline?: RootTimelineSnapshot
  state: ChatOpenStateSnapshot & {
    /** Root mode identity set used to atomically clear stale descendant state. */
    chatIds?: string[]
    pendingApproval?: CurrentStateData['pendingApproval']
    questionBatches: PendingQuestionBatchData[]
    runningTools: CurrentStateData['runningTools']
    executionSteps: ExecutionStep[]
    roles: Array<Record<string, unknown>>
  }
}

export interface ChatCloseRequestData {
  subscriptionId: string
}

export interface ChatCloseResponseData {
  subscriptionId: string
  chatId?: string
  closed: boolean
}

/** Starts a persisted role spawn task exactly once. */
export interface ChatStartSpawnRequestData {
  taskId: string
}

export interface SenseApprovalRequestData {
  approvalId: string
  action: 'accept' | 'reject'
  reason?: string
}

export interface InteractionListRequestData {
  presetId?: string
  includeActivity?: boolean
  /** lite profile（P0，R8）：单页上限，≤20；缺省 = 服务端默认窗口。超出的待办以 hasMore 标志暴露。 */
  maxItems?: number
}

export interface InteractionData {
  interactionId: string
  kind: 'approval' | 'question_batch'
  chatId: string
  rootChatId: string
  presetId?: string
  anchorNodeId?: string
  status: 'pending' | 'resolving' | 'completed' | 'expired' | 'cancelled' | 'blocked'
  payload: Record<string, unknown>
  deadlineAt?: number
  result?: Record<string, unknown>
  revision: number
  createdAt: number
  updatedAt: number
  completedAt?: number
}

export interface InteractionListResponseData {
  interactions: InteractionData[]
  /** lite（P0）：服务端时钟校准（B-3：设备无 NTP 时以 serverNow 校准本地钟）。 */
  serverNow?: number
  /** lite（P0，R8）：maxItems 分页时携带；true = 仍有未返回条目（无 OFFSET 游标，客户端重拉全量窗口即可）。 */
  hasMore?: boolean
  /** lite（P0）：payload 被字段级截断的条目引用（interactionId + 被截字段 + 原文长度/哈希；全文走交互详情）。 */
  truncations?: Array<{
    interactionId: string
    field: string
    contentLength: number
    contentHash: string
  }>
}
export interface InteractionApprovalDecideRequestData {
  interactionId: string
  action: 'accept' | 'reject'
  expectedRevision: number
  commandId: string
  reason?: string
}
export interface InteractionApprovalDecideResponseData {
  interaction: InteractionData
}
export interface InteractionQuestionAnswerRequestData {
  interactionId: string
  expectedRevision: number
  commandId: string
  answers: SenseQuestionBatchAnswerRequestData['answers']
}
export interface InteractionQuestionAnswerResponseData {
  interaction: InteractionData
}

/**
 * sense.question.answer 入参（用户回答 ask_user_question）。
 * selectedLabels：用户点选的 label 数组（单选=1 项；多选=N 项；「其他」自由文本时为空数组）。
 * freeText：「其他」chip 触发模态对话框时输入的自由文本（普通 chip 选中时为 undefined）。
 * cancelled：true = 用户点 ✕ 取消；正常答案时省略或 false。
 */
export interface SenseQuestionAnswerRequestData {
  questionId: string
  selectedLabels: string[]
  /** 每选项补充描述：label → note（可选，向后兼容；仅已选选项生效）。 */
  optionNotes?: Record<string, string>
  freeText?: string
  cancelled?: boolean
}

export interface SenseQuestionAnswerResponseData {
  questionId: string
  cancelled: boolean
}

/** 原子提交一个持久化问题批次。answers 必须恰好覆盖批次内所有仍 pending 的问题。 */
export interface SenseQuestionBatchAnswerRequestData {
  chatId: string
  batchId: string
  answers: Array<{
    questionId: string
    selectedLabels: string[]
    /** 每选项补充描述：label → note（可选，向后兼容；仅已选选项生效）。 */
    optionNotes?: Record<string, string>
    freeText?: string
    cancelled?: boolean
  }>
}

export interface SenseQuestionBatchAnswerResponseData {
  chatId: string
  batchId: string
  completed: boolean
  /** true 时调用方应启动 chat.resume；重复提交已完成批次时为 false。 */
  shouldResume: boolean
}

export interface ChatAbortRequestData {
  chatId: string
  /** 仅中止该运行；与当前 active run 不一致时返回 CONFLICT，防止旧页面误杀新一轮。 */
  runId?: string
  /** Optional idempotency key used by the CP8 global pause command. */
  commandId?: string
}

export type ChildAgentControlState = 'running' | 'paused' | 'finished' | 'failed' | 'redirected'

export interface ChildControlTargetResult {
  chatId: string
  previousState: ChildAgentControlState
  state: ChildAgentControlState
  outcome: 'stopped' | 'queued' | 'resumed' | 'unchanged' | 'rejected' | 'failed'
  runId?: string
  messageId?: string
  detail?: string
}

export interface ChatStopChildRequestData {
  rootChatId: string
  childChatId: string
  commandId: string
  recursive?: boolean
}

export interface ChatStopChildResponseData {
  rootChatId: string
  commandId: string
  results: ChildControlTargetResult[]
}

export interface ChatSendToChildRequestData {
  rootChatId: string
  childChatId: string
  commandId: string
  content: string
}

export interface ChatSendToChildResponseData {
  rootChatId: string
  commandId: string
  result: ChildControlTargetResult
}

export interface ChatAttachRequestData {
  chatId: string
}

export interface BashKillRequestData {
  chatId: string
  pid: number
}

export interface BashListRequestData {
  chatId: string
}
