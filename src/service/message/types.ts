import { randomUUID } from 'crypto'
import { SupervisionLevel } from '@/core/config.js'
import type { McpServerInfo } from '@/core/mcp/types.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import type { ConfigRaw } from '@/utils/config.js'
import type { ContextBreakdown } from '@/utils/token.js'
import type { ThinkingBlockDelta } from '@/core/message/adapter.js'

// ========== 消息基础类型 ==========

/**
 * 请求消息（C→S）
 */
export type Request<M extends Method = Method> = {
  [K in M]: {
    id: string
    kind: 'request'
    method: K
    params: ParamsOf<K>
  }
}[M]

/**
 * 响应消息（S→C，请求返回）
 */
export interface Response<TData extends ResponseData = ResponseData> {
  id: string
  kind: 'response'
  requestId: string
  success: boolean
  data?: TData
  error?: RpcError
}

/**
 * Chunk消息（S→C，流式增量）
 */
export interface Chunk {
  kind: 'chunk'
  type: 'stream' | 'staged'
  requestId: string
  /** 事件所属 chat。不得再通过 requestId 猜测 chat 路由。 */
  chatId?: string
  /** 一次 chat.send/chat.resume 运行的稳定标识；当前实现中等于启动该运行的 Request.id。 */
  runId?: string
  /** Chat event sequence. Present for recoverable live events and chat.sync replays. */
  seq?: number
  /** V2 session event sequence (alias of seq for recoverable events). */
  eventSeq?: number
  /** V2 session subscription that received this event. */
  subscriptionId?: string
  /** Root tree that owns this event when routed through a root subscription. */
  rootChatId?: string
  /** Monotonic cursor across the entire recursive root tree. */
  rootEventSeq?: number
  /** Original per-chat cursor retained inside a root subscription envelope. */
  sourceEventSeq?: number
  data: ChunkData
}

/**
 * Notification消息（S→C，服务端推送）
 */
export interface Notification {
  kind: 'notification'
  type: NotificationType
  /** 触发该事件的 RPC 请求；脱离请求异步推送时省略。 */
  requestId?: string
  /** 事件所属 chat。role_created/role_reply 等异步事件必须使用此字段路由。 */
  chatId?: string
  /** 事件所属运行；非某次运行产生的异步事件可省略。 */
  runId?: string
  /** Chat event sequence. Present for recoverable live events and chat.sync replays. */
  seq?: number
  /** V2 session event sequence (alias of seq for recoverable events). */
  eventSeq?: number
  /** V2 session subscription that received this event. */
  subscriptionId?: string
  /** Root tree that owns this event when routed through a root subscription. */
  rootChatId?: string
  /** Monotonic cursor across the entire recursive root tree. */
  rootEventSeq?: number
  /** Original per-chat cursor retained inside a root subscription envelope. */
  sourceEventSeq?: number
  data: NotificationData
}

/** Chunk/Notification 共用的显式业务关联字段。 */
export interface EventContext {
  chatId?: string
  runId?: string
}

export type NotificationType =
  | 'interrupt' // 感官审批请求（sense_end，仅 smart/manual）
  | 'sense_started' // 感官开始执行（sense_end，仅 auto；前端维护「运行中工具」列表）
  | 'accept' // 感官执行成功（全工具；approvalId=sense id，前端移除运行中工具同 id 项）
  | 'rejected' // 感官执行被拒绝
  | 'consumed' // 消息已消费
  | 'loaded' // 历史对话已载入
  | 'done' // 执行完成
  | 'error' // 错误
  | 'replaced' // 感官去重命中：历史 sense 结果被新读取替换
  | 'role_created' // 角色（子 pet）派发（spawn_role sense 执行时推送给主 chat 所属连接）
  | 'role_destroyed' // 角色销毁（destroy_role sense 执行时推送给主 chat 所属连接，CP6）
  | 'role_reply' // wake=immediate 子完成/策略满足唤主时推（前端 chat.resume 续跑）；deferred/barrier silent 路径不推
  | 'child_abandoned' // 看门狗超时(wake_on_timeout=true)子 agent 被掐断：前端据 childChatId 即时转 ghost（与 role_reply 并列，不唤主不注入历史）
  | 'question_requested' // ask_user_question 旧版逐题事件（兼容历史事件重放）
  | 'question_answered' // ask_user_question 旧版逐题完成事件（兼容）
  | 'question_batch_requested' // 一个 assistant turn 的完整问题批次
  | 'question_batch_completed' // 批次已原子完成，前端清理本地投影
  | 'auto_compacted' // 自动压缩：chat 上下文超阈值自动注入 [[command:/compact]]，推前端显「已自动压缩」toast
  | 'timeline.patch' // 持久化消息事务提交后的权威时间线 patch
  | 'turn.started'
  | 'turn.delta'
  | 'turn.completed'
  | 'input.updated'
  | 'run.updated'
  | 'interaction.changed'

// ========== Request Data ==========

/** 严格空对象：用于无参数请求与无 data 成功响应，避免裸 `{}` 吞并联合成员。 */
export type EmptyObjectData = Record<string, never>

export type BrainListRequestData = EmptyObjectData

export type SenseListRequestData = EmptyObjectData

export type SenseToolsRequestData = EmptyObjectData

/** skills.list：列出用户配置目录中当前可用的 Skill 元数据。支持可选分页与搜索。 */
export interface SkillsListRequestData {
  /** 1-based 页码；省略或 1 = 第一页；未给 pageSize 时忽略（返回全量）。 */
  page?: number
  /** 每页条数；默认 50，最大 200；未给 page 时忽略（返回全量）。 */
  pageSize?: number
  /** 按名称/描述/触发词模糊搜索（大小写不敏感）。 */
  search?: string
  /**
   * 插件过滤：undefined 或省略 = 仅独立 skill；"*" = 全部；具体字符串 = 该插件下的 skill。
   * 与 SkillFilter 互补：SkillFilter 用于 per-role 白名单，此参数用于 UI 列表展示过滤。
   */
  plugin?: string
}

export type PromptsListRequestData = EmptyObjectData
export type RulesListRequestData = EmptyObjectData

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
}

export interface ChatListRequestData {
  /**
   * true：每项增返 preview（首条 user 消息截断）+ turnCount（user 消息数），供会话列表渲染。
   * 省略/false：lean，不查 messages，供初始化重建 pet 树（免 N+1）。CP8。
   */
  includePreview?: boolean
}

export interface ChatRouteSuggestRequestData {
  presetId: string
  draft: string
  requestVersion: number
}

export interface ChatRouteCandidateData {
  chatId: string | null
  confidence: number
  reason: string
}

export interface ChatRouteSuggestResponseData {
  requestVersion: number
  candidates: ChatRouteCandidateData[]
}

export interface ChatGetRequestData {
  chatId: string
}

export interface ChatContextUsageRequestData {
  chatId: string
}

export interface ChatDeleteRequestData {
  chatId: string
}

export type ConversationBranchKind = 'original' | 'continuation' | 'detail'

export interface ConversationBranchSummary {
  branchId: string
  taskId: string
  chatId: string
  kind: ConversationBranchKind
  sourceBranchId?: string
  anchorRootChatId?: string
  anchorNodeId?: string
  /** First user message in this branch, used as the history selector label. */
  title?: string
  createdAt: number
}

export interface BranchSideEffect {
  nodeId: string
  callId: string
  toolName: string
  arguments: string
  result?: string
}

export interface ChatBranchPreviewRequestData { rootChatId: string; anchorNodeId: string }
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
  status: 'pending' | 'started' | 'finished' | 'timed_out'
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
export interface ChatAbortTaskRequestData { taskId: string; commandId: string }
export interface ChatAbortTaskResponseData {
  taskId: string
  abortedBranches: string[]
}
export interface ChatBranchActivateRequestData { branchId: string; commandId: string }
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
export interface ChatInputSubmitRequestData {
  chatId: string
  commandId: string
  clientMessageId: string
  /** Client-preallocated durable user node identity. The accepted input and
   * committed timeline node reuse it so the tree never deletes/recreates the node. */
  messageId: string
  content: string
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

export type TreeControlOperationStatus =
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'partial'
  | 'completed'
  | 'superseded'

export type TreeControlTargetStatus =
  | 'paused'
  | 'resuming'
  | 'resumed'
  | 'delegated'
  | 'skipped'
  | 'failed'

export interface TreeControlTarget {
  chatId: string
  pausedRunId: string
  status: TreeControlTargetStatus
  resumeRunId?: string
  detail?: string
}

export interface TreeControlState {
  pauseId: string
  rootChatId: string
  status: TreeControlOperationStatus
  createdAt: number
  updatedAt: number
  targets: TreeControlTarget[]
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
export interface ChatOpenRequestData {
  chatId?: string
  /** Root mode subscribes every current and future descendant chat. */
  rootChatId?: string
  knownTimelineRevision?: number
  knownEventSeq?: number
}

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

export interface PendingInputSnapshot {
  /** Present for root snapshots so the client can preserve source identity. */
  chatId?: string
  inputId: string
  clientMessageId?: string
  messageId?: string
  content: string
  createdAt: number
  state: 'accepted' | 'started' | 'queued' | 'consumed' | 'cancelled' | 'rejected'
  queueSequence?: number
  acceptedAt?: number
}

export interface ChatOpenResponseData {
  chatId: string
  subscriptionId: string
  eventSeq: number
  timelineRevision: number
  timelineChanged: boolean
  rootTimeline?: RootTimelineSnapshot
  state: {
    /** Root mode identity set used to atomically clear stale descendant state. */
    chatIds?: string[]
    run?: { runId: string; state: 'running' | 'paused' | 'completed' | 'failed' }
    /** Root mode returns every active descendant run; direct mode leaves this empty. */
    runs?: Array<{
      chatId: string
      runId: string
      state: 'running' | 'paused' | 'completed' | 'failed'
    }>
    pendingInputs: PendingInputSnapshot[]
    activeTurns: ActiveTurnSnapshot[]
    pendingApproval?: CurrentStateData['pendingApproval']
    questionBatches: PendingQuestionBatchData[]
    runningTools: CurrentStateData['runningTools']
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

export interface InteractionListResponseData { interactions: InteractionData[] }
export interface InteractionApprovalDecideRequestData {
  interactionId: string
  action: 'accept' | 'reject'
  expectedRevision: number
  commandId: string
  reason?: string
}
export interface InteractionApprovalDecideResponseData { interaction: InteractionData }
export interface InteractionQuestionAnswerRequestData {
  interactionId: string
  expectedRevision: number
  commandId: string
  answers: SenseQuestionBatchAnswerRequestData['answers']
}
export interface InteractionQuestionAnswerResponseData { interaction: InteractionData }

/**
 * sense.question.answer 入参（用户回答 ask_user_question）。
 * selectedLabels：用户点选的 label 数组（单选=1 项；多选=N 项；「其他」自由文本时为空数组）。
 * freeText：「其他」chip 触发模态对话框时输入的自由文本（普通 chip 选中时为 undefined）。
 * cancelled：true = 用户点 ✕ 取消；正常答案时省略或 false。
 */
export interface SenseQuestionAnswerRequestData {
  questionId: string
  selectedLabels: string[]
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

// ---------- MCP 管理（连接层）----------

export type McpListRequestData = EmptyObjectData

export interface McpGetRequestData {
  name: string
}

export interface McpConnectRequestData {
  name: string
}

export interface McpDisconnectRequestData {
  name: string
}

/**
 * mcp.reload：name 给出→原子重载单个 server；name 省略→全量重载（重读 config）。
 */
export interface McpReloadRequestData {
  name?: string
}

/**
 * subagent.result RPC 已于 2026-07-09 废弃（wait=true 改后端注入唤醒，见 docs/agent-pet.md §5.4）。
 * 原前端→后端结果回传通道移除：SubagentResultRequestData / SubagentResultResponseData / Method.SUBAGENT_RESULT / handler / schema 全删。
 */

// ---------- Config 设置（config.get / config.save）----------

/** config.get 请求：空参 */
export type ConfigGetRequestData = EmptyObjectData

/** config.save 入参：除 server 外全部字段（结构同 ConfigRaw，supervision 为字符串、key 为 $ENV 占位符） */
export type ConfigSaveRequestData = ConfigRaw

/** config.workspace.validate：只读校验后端主机上的预设工作区目录。空值表示未限定，为有效值。 */
export interface ConfigWorkspaceValidateRequestData {
  workspace?: string
}

// ---------- Hooks 管理（hooks.get / hooks.save / hooks.events）----------

/** hooks.get 请求：空参 */
export type HooksGetRequestData = EmptyObjectData

/** hooks.save 入参：全局 hooks.json 完整内容（事件 → handler 列表）*/
export interface HooksSaveRequestData {
  handlers: Record<string, HooksHandlerDTO[]>
}

/** hooks.events 请求：空参 */
export type HooksEventsRequestData = EmptyObjectData

/** hooks handler 传输对象（对齐 HookHandlerConfig）*/
export interface HooksHandlerDTO {
  matcher?: string
  if?: string
  command: string
  timeout?: number
}

/** hooks.events 响应：静态事件元数据 */
export interface HooksEventsResponseData {
  events: Array<{
    name: string
    label?: string
    description: string
    /** 该事件 handler 能做的能力（前端 chip 展示）*/
    capabilities: string[]
    /** matcher 比对的 payload 字段名（提示用户 matcher 匹配什么）*/
    matcherField?: string
  }>
}

// ---------- Utils 工具（独立信息查询，不依赖 chat/brain 运行时）----------

/**
 * utils.models：基于用户提供的 provider/url/key 拉取可用模型列表。
 * provider 必填（区分调用方式），url 必填，key 可选（ollama 通常无需）。
 */
export interface UtilsModelsRequestData {
  provider: string
  url: string
  key?: string
}

/**
 * utils.testConnection：用未保存的 brain 连接字段执行真实最小 Provider 请求。
 * key 可选：Ollama 通常无需密钥。
 */
export interface UtilsTestConnectionRequestData {
  provider: string
  url: string
  key?: string
  model: string
}

/**
 * utils.thinkingLevels：按模型名批量查询 ThinkingLevel 档位列表。
 * 用于前端 settings 渲染「深度思考」旋钮（不同模型暴露不同档位）。
 * 后端按 `.chery/model-thinking.yaml` 配置匹配，未命中返回 `["off", "on"]` 兜底。
 * models：1~N 个模型名（数组去重由调用方负责；空数组返回 `{}`）。
 */
export interface UtilsThinkingLevelsRequestData {
  models: string[]
}

// ---------- Env 环境变量 ----------

/** env.list 请求：空参 */
export type EnvListRequestData = EmptyObjectData

// ---------- Utils 打开文件 ----------

/**
 * utils.openFile：打开指定文件（用配置的文本编辑器或系统默认）。
 * path：相对 .chery 目录的文件路径（如 config.yaml、.env、prompts/leader.md）。
 */
export interface UtilsOpenFileRequestData {
  path: string
}

/**
 * utils.editors：获取系统可用的文本编辑器列表。
 * 返回主流编辑器（VSCode、记事本、TextEdit、gedit 等），供前端下拉选择。
 */
export type UtilsEditorsRequestData = EmptyObjectData

/** utils.openConfigDir：固定打开后端主机的 CHERY_DIR/.chery，不接受客户端路径。 */
export type UtilsOpenConfigDirRequestData = EmptyObjectData

// ---------- 内置命令系统（命令管理 Tab 后端）----------

/** 单条 .chery/command/<name>.md 元信息 */
export interface CommandInfo {
  /** 命令名（= 文件名 basename，无 .md 后缀） */
  name: string
  /** 文件 frontmatter.description；缺失时为 "" */
  description: string
  /** frontmatter 与正文之间的纯指令正文（trim 后） */
  content: string
}

/** command.list 响应：所有内置命令文件元信息 */
export interface CommandListResponseData {
  commands: CommandInfo[]
}

/**
 * chat 上下文暴露的 command 系统配置（前端 PetToolbar / 设置面板用）。compact 无开关。
 * - warn → 前端视觉提示阈值（contextUsage ≥ warn 时提示）；不参与后端触发。
 * - auto → 自动触发阈值（thresholdReached 命中即压缩）。
 * - min_context_limit → 只有 brain.contextLimit ≥ 此值才启用 compact（「不可用」门槛）。
 */
export interface ThresholdData {
  unit: 'tokens' | 'percent'
  value: number
}

export interface CommandConfigData {
  warn: ThresholdData
  auto: ThresholdData
  minContextLimit: number
}

// ========== Response Data ==========

export interface BrainListResponseData {
  brains: Array<{
    name: string
    provider: string
    model: string
    thinking?: import('@/core/llm/adapter.js').ThinkingLevel
    capabilities?: import('@/utils/config.js').BrainCapabilities
    /** 上下文长度上限（token），供前端 context bar 显示用量。缺省 undefined */
    contextLimit?: number
    /** 是否为「默认」预设 leader 角色的 brain（前端 AgentDialog 无 runtime 时预选默认 brain） */
    default?: boolean
    senseGroups?: string | string[]
  }>
  /** 当前已连接的 MCP server 名（供前端按 server 渲染开关） */
  mcpServers: string[]
}

export interface SenseListResponseData {
  senseGroups: Array<{
    name: string
    supervision?: SupervisionLevel
    senses: string[]
  }>
}

/**
 * sense.tools 响应：代码维护的全部内置工具元信息。
 * name=原名（作 sense_groups 条目 key，如 "execute_command"）；
 * label=中文名（UI 显示）；description=解释（tooltip）。
 * 自定义/外部/MCP 工具不在内，前端组合框允许自由输入。
 */
export interface SenseToolMeta {
  name: string
  label: string
  description: string
  /** glyph/emoji 字符串（pet bar 运行中工具图标用）。非内置工具前端 fallback ⚙。 */
  icon: string
}

export interface SenseToolsResponseData {
  tools: SenseToolMeta[]
}

/** skills.list 响应：用户 `.chery/skills/` 独立 skill + `.chery/plugins/` 插件 skill；不含前端内置命令。 */
export interface SkillsListResponseData {
  skills: Array<{
    name: string
    description: string
    trigger?: string
    /** 激活该技能后写入模型上下文的近似 token 增量（= 系统提示词 + 内容提示词之和）。 */
    contextTokens: number
    /** 系统提示词占用：注入 system prompt `<skills>` XML 的 name+description token。 */
    nameDescTokens: number
    /** 系统提示词占用：trigger 行 token（可选，无 trigger 则省略）。 */
    triggerTokens?: number
    /** 内容提示词占用：激活后加载的技能正文 token。 */
    contentTokens: number
    /** 来源插件名（undefined = 独立 skill；否则为插件 skill，name 形如 `<plugin>__<skill>`）。 */
    plugin?: string
  }>
  /** 匹配条件总条数（分页时前端需要知道总数）。无分页时等于 skills.length。 */
  total: number
  /** 当前页码（1-based）；无分页时为 1。 */
  page: number
  /** 每页条数；无分页时为 skills.length。 */
  pageSize: number
}

/** skills.listNames：轻量接口，仅返回全部 skill 名称（不算 token），供角色卡下拉使用。 */
export type SkillsListNamesRequestData = EmptyObjectData
export interface SkillsListNamesResponseData {
  /** 全部独立 skill 名。 */
  skills: string[]
  /** 全部插件名。 */
  plugins: string[]
  /** 角色装备摘要用的系统提示词 token，不读取技能正文。 */
  skillTokens: Record<string, number>
  pluginTokens: Record<string, number>
}

/** 导入候选 skill（两阶段导入的 stage 产物）。 */
export interface SkillCandidate {
  /** sanitize 后的 skill 目录名（= 未来 skills_dir/<name>）。 */
  name: string
  description: string
  trigger?: string
  /** skills_dir/<name> 已存在 → 冲突，需前端逐项确认覆盖/跳过。 */
  conflict: boolean
}

/** skills 导入 stage 结果（HTTP /api/skills/import 与 skills.importUrl 共用）。 */
export interface SkillStageResult {
  stagingId: string
  candidates: SkillCandidate[]
}

/** skills.preImportUrl：解析 URL + git ls-remote 取分支列表 + 鉴权/git 探测（不 clone）。 */
export interface SkillsPreImportUrlRequestData {
  url: string
  /** 选中凭据池 id（私有仓二次尝试时带）；首次省略。 */
  credentialId?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface SkillsPreImportUrlResponseData {
  /** 系统 git 缺失（功能不可用，前端据此禁用）。 */
  gitNotInstalled: boolean
  /** 需要鉴权（私有仓）。 */
  needsAuth: boolean
  branches: string[]
  defaultBranch?: string
}

/**
 * skills.importUrl：按选定分支 git clone 独立技能集合到 staging 分析候选（对标插件：分支选择 + 鉴权）。
 * 鉴权：credentialId（凭据池）优先；否则 inline {username,password}（remember=true 时入池）。互斥。
 */
export interface SkillsImportUrlRequestData {
  url: string
  branch: string
  credentialId?: string
  /** inline 入口（与 credentialId 互斥）。 */
  username?: string
  password?: string
  /** 为 true 时把 inline {username,password,label} 加密入池并回填 savedCredentialId。 */
  remember?: boolean
  label?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface SkillsImportUrlResponseData extends SkillStageResult {
  /** 选中分支（URL 导入才有；zip 上传无）。 */
  branch?: string
  /** HEAD 短 SHA（URL 导入才有）。 */
  commitSha?: string
  /** HEAD 提交时间 ISO（URL 导入才有）。 */
  commitDate?: string
  /** inline + remember 成功入池时回填的新凭据 id。 */
  savedCredentialId?: string
}

/** skills.commit 单项选择：import=false → 跳过；true → 导入（冲突则覆盖）。 */
export interface SkillCommitSelection {
  name: string
  import: boolean
}
export interface SkillsCommitRequestData {
  stagingId: string
  selections: SkillCommitSelection[]
}
export interface SkillsCommitResponseData {
  imported: string[]
  skipped: string[]
}

/** skills.delete：删除独立 skill 目录（plugins_dir 下的插件 skill 不在此列）。 */
export interface SkillsDeleteRequestData {
  name: string
}
export interface SkillsDeleteResponseData {
  ok: true
}

/** git 来源索引项（.chery/.skill-sources.json 单条；按 {cloneUrl,branch} 分组）。 */
export interface SkillSourceEntry {
  /** 稳定 id = sha1(cloneUrl+branch) 前 12 位。 */
  id: string
  /** 规范化 https clone URL。 */
  cloneUrl: string
  branch: string
  /** 关联凭据池 id（re-sync 时复用；未存则 undefined）。 */
  credentialId?: string
  /** 上次同步时的 HEAD 短 SHA。 */
  commitSha: string
  /** 上次同步时的 HEAD 提交时间 ISO。 */
  commitDate: string
  /** 上次同步时间 ISO。 */
  lastSyncedAt: string
  /** 最近一次 resyncAllSources 错误信息（成功时清除；从未批量刷新或非失败结果为 undefined）。 */
  lastSyncError?: string
  lastCheckedAt?: string
  latestSha?: string
  latestDate?: string
  updateAvailable?: boolean
  lastCheckError?: string
  /** 跟踪的 skill 文件夹名（skills_dir 下的目录名）。 */
  skills: string[]
}
/** skills.listSources 返回项：仓库摘要，不展开关联技能。 */
export interface SkillSourceDTO extends Omit<SkillSourceEntry, 'skills'> {
  skillCount: number
}
/** skills.listSources：列出 git 来源中央索引。 */
export type SkillsListSourcesRequestData = EmptyObjectData
export interface SkillsListSourcesResponseData {
  sources: SkillSourceDTO[]
}
export interface SkillsCheckSourceRequestData {
  sourceId: string
}
export interface SkillsCheckSourceResponseData {
  sourceId: string
  latestSha: string
  latestDate?: string
  updateAvailable: boolean
}
export type SkillsCheckAllSourcesRequestData = EmptyObjectData
export interface SkillsCheckAllSourcesResponseData {
  checked: number
  updatesAvailable: number
  failed: Array<{ sourceId: string; reason: string }>
}
/** skills.resyncSource：重 clone 某来源 + 重分析候选（前端重弹候选列表预勾选）。 */
export interface SkillsResyncSourceRequestData {
  sourceId: string
}
export interface SkillsResyncSourceResponseData extends SkillStageResult {
  branch: string
  commitSha: string
  commitDate: string
  sourceId: string
  /** 该来源原先跟踪的技能，前端默认继续勾选。 */
  selected: string[]
}
/** skills.deleteSource：删来源索引条目 + 其跟踪的 skill 文件夹。 */
export interface SkillsDeleteSourceRequestData {
  sourceId: string
}
export interface SkillsDeleteSourceResponseData {
  ok: true
}
/**
 * skills.resyncAllSources：批量重拉全部来源（非交互）。
 * 自动 commit 仅匹配原 entry.skills 命名的 candidate；新增/删除静默丢弃（避免与手动 resyncSource 行为交叉）。
 * 失败条目同步写入 SkillSourceEntry.lastSyncError 便于下次刷新前展示「刷新失败」红 pill。
 */
export type SkillsResyncAllSourcesRequestData = EmptyObjectData
export interface SkillsResyncAllSourcesEntry {
  sourceId: string
  ok: boolean
  /** 失败时附带错误信息（鉴权/网络/git 缺失等）。 */
  error?: string
  /** 成功时新 HEAD SHA。 */
  commitSha?: string
  /** 成功时新 HEAD commit 时间 ISO。 */
  commitDate?: string
}
export interface SkillsResyncAllSourcesResponseData {
  results: SkillsResyncAllSourcesEntry[]
  successes: number
  failures: number
}

// ========== 插件管理 ==========

/** 插件内 skill 元信息（plugins.list 展示用）。name 为对外名 `<plugin>__<skill>`。
 *  token 字段（nameDescTokens/triggerTokens/contentTokens）与 skill 端 `computeSkillTokens` 同源，
 *  供前端插件卡展示「系统 ≈N」「内容 min–max」+ tag tip。 */
export interface PluginSkillInfo {
  name: string
  description: string
  trigger?: string
  /** name + description 的 token 数（不含 trigger / 正文）。 */
  nameDescTokens: number
  /** trigger 行的 token 数（无 trigger 时为 0）。 */
  triggerTokens?: number
  /** 正文 content 的 token 数。 */
  contentTokens: number
}

/** 插件信息（来源 .chery/plugins/<name>/.chery-plugin.json manifest + 扫描其 skills）。 */
export interface PluginInfo {
  name: string
  sourceUrl: string
  /** 规范化 clone URL（https .git）；旧 manifest 缺失为空串。 */
  cloneUrl: string
  /** 跟踪的分支；旧 manifest 缺失为空串。 */
  branch: string
  /** 安装时的 HEAD 短 SHA；旧 manifest 缺失为空串。 */
  commitSha: string
  /** 安装时的 commit ISO 时间；旧 manifest 缺失为空串。 */
  commitDate: string
  installedAt: string
  updatedAt: string
  /** 最近一次检查更新时间（manifest 持久化）；从未检查为 undefined。 */
  lastCheckedAt?: string
  /** 远端最新 HEAD 短 SHA（最近一次检查写入）；未检查为 undefined。 */
  latestSha?: string
  /** 远端最新 commit ISO（最近一次检查写入）；私有仓 401 或未检查为 undefined。 */
  latestDate?: string
  /** 当前 commitSha 与 latestSha 不一致（最近一次检查写入）；未检查为 undefined。 */
  updateAvailable?: boolean
  /** 最近一次 checkUpdate 错误信息（成功时清除；从未检查或检查成功的为 undefined）。 */
  lastCheckError?: string
  /** 该插件全部 skill 的系统 token 总量（Σ nameDescTokens + triggerTokens）。 */
  totalSystemTokens: number
  /** 该插件 skill 中正文 token 的最小值（无 skill 时为 0）。 */
  minContentTokens: number
  /** 该插件 skill 中正文 token 的最大值（无 skill 时为 0）。 */
  maxContentTokens: number
  skills: PluginSkillInfo[]
}

/** plugins.list：列出已安装插件（.chery/plugins 下各子目录）。 */
export type PluginsListRequestData = EmptyObjectData
export interface PluginsListResponseData {
  plugins: PluginInfo[]
}

/**
 * plugins.preImportUrl：解析 URL + git ls-remote 取分支列表。
 * - needsAuth=true → 私有仓需凭据（前端弹用户名/密码或选凭据池后重试）。
 * - gitNotInstalled=true → 系统 git 缺失（硬性前提），前端禁用导入入口。
 */
export interface PluginsPreImportUrlRequestData {
  url: string
  /** 选中的凭据池 id（私有仓二次尝试时带）；首次省略。 */
  credentialId?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface PluginsPreImportUrlResponseData {
  /** 系统 git 缺失（功能不可用，前端据此禁用）。 */
  gitNotInstalled: boolean
  /** 需要鉴权（私有仓）。 */
  needsAuth: boolean
  branches: string[]
  defaultBranch?: string
  owner: string
  repo: string
  /** 建议的插件文件夹名（= sanitizeName(repo)）；前端预填「文件夹名」输入框。 */
  suggestedName: string
  /** 该文件夹名已存在（pluginDirExists）→ 前端展示「文件夹名」输入框供改名。 */
  nameConflict: boolean
}

/**
 * plugins.importUrl：按选定分支 git clone 整仓到 staging 预览（含 existing 冲突）。
 * 鉴权：credentialId（凭据池）优先；否则 inline {username,password}（remember=true 时入池）。
 * credentialId 与 inline password 互斥（schema refine）。
 */
export interface PluginsImportUrlRequestData {
  url: string
  branch: string
  credentialId?: string
  /** inline 入口（与 credentialId 互斥）。 */
  username?: string
  password?: string
  /** 为 true 时把 inline {username,password,label} 加密入池并回填 savedCredentialId。 */
  remember?: boolean
  label?: string
  /**
   * 插件文件夹名覆盖（preImport 返回 nameConflict=true 时由前端提供）。
   * 省略 → 用 sanitizeName(repo)。提供 → 再次 sanitize；与既有文件夹冲突时 existing=true，走 commit overwrite。
   */
  pluginName?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface PluginsImportUrlResponseData {
  stagingId: string
  pluginName: string
  existing: boolean
  sourceUrl: string
  branch: string
  commitSha: string
  commitDate: string
  /** remember=true 且新建凭据时回填，供前端刷新凭据池下拉。 */
  savedCredentialId?: string
  skills: PluginSkillInfo[]
}

/** plugins.commit：确认落盘（overwrite=true 则覆盖同名插件）。 */
export interface PluginsCommitRequestData {
  stagingId: string
  overwrite: boolean
}
export interface PluginsCommitResponseData {
  plugin: PluginInfo
}

/**
 * plugins.checkUpdate：对比 manifest 当前 HEAD 与远端分支 HEAD。
 * - updateAvailable = currentSha !== latestSha（currentSha 缺失视为有更新）。
 * - latestDate 私有仓 REST 401 时为 undefined（前端隐藏日期 pill）。
 * - needsAuth=true → 远端需鉴权才能检查（前端提示）。
 */
export interface PluginsCheckUpdateRequestData {
  name: string
}
export interface PluginsCheckUpdateResponseData {
  gitNotInstalled: boolean
  needsAuth: boolean
  currentSha: string
  currentDate: string
  latestSha: string
  latestDate?: string
  /** manifest.updatedAt。 */
  lastUpgrade: string
  updateAvailable: boolean
}

/**
 * plugins.checkAllUpdates：批量检查全部已安装插件的远端 HEAD，结果写入各插件 manifest
 * （lastCheckedAt / latestSha / latestDate / updateAvailable）。前端随后 refresh() 重拉 list 读取。
 * 单个插件检查失败（如私有仓 needsAuth / 网络错误）计入 failed 数组，不中断整体。
 */
export type PluginsCheckAllUpdatesRequestData = EmptyObjectData
export interface PluginsCheckAllUpdatesFailure {
  name: string
  /** 失败原因（needsAuth / 网络错误等），前端可选展示。 */
  reason: string
}
export interface PluginsCheckAllUpdatesResponseData {
  /** 本次实际检查的插件数（含失败）。 */
  checked: number
  /** 检测到有更新的插件数。 */
  updatesAvailable: number
  /** 检查失败的插件（不中断整体）。 */
  failed: PluginsCheckAllUpdatesFailure[]
}

/** plugins.update：按 manifest.cloneUrl+branch 重新 clone 覆盖（保留 pluginName + installedAt）。 */
export interface PluginsUpdateRequestData {
  name: string
}
export interface PluginsUpdateResponseData {
  plugin: PluginInfo
}

/** plugins.uninstall：删除整个插件目录。 */
export interface PluginsUninstallRequestData {
  name: string
}
export interface PluginsUninstallResponseData {
  ok: true
}

// ========== 凭据池（通用） ==========

/** 凭据池条目（密令永不回前端）。 */
export interface CredentialListItemDTO {
  id: string
  label: string
  username: string
  createdAt: string
}

/** credentials.list：列出全部已存凭据（仅 id/label/username）。 */
export type CredentialsListRequestData = EmptyObjectData
export interface CredentialsListResponseData {
  credentials: CredentialListItemDTO[]
}

/** credentials.save：加密入池（密令后端 AES-256-GCM 加密，不入日志——schema 字段名 password 自动脱敏）。 */
export interface CredentialsSaveRequestData {
  label: string
  username: string
  password: string
}
export interface CredentialsSaveResponseData {
  credential: CredentialListItemDTO
}

/** credentials.delete：从池中删除。 */
export interface CredentialsDeleteRequestData {
  id: string
}
export interface CredentialsDeleteResponseData {
  ok: true
}

/**
 * prompts.list 响应：.chery/prompt/ 下全部 .md 的相对路径（相对 .chery/，含 prompt/ 前缀，排除全局 base system.md）。
 * 供设置面板 systemPrompt 级联选择器建目录树；叶 value = 全路径 = 存储值。
 */
export interface PromptsListResponseData {
  prompts: string[]
}

/**
 * rules.list 响应：.chery/rule/ 下全部 .yaml 文件名（**排除基准 base.yaml**），供设置面板预设 tab
 * 「规则文件」下拉填充。目录为空/不存在 → []。
 */
export interface RulesListResponseData {
  rules: string[]
}

export interface ChatCreateResponseData {
  chatId: string
  presetId?: string
  /** 回显已生效的 runtime selection（含 MCP 开关） */
  brain: string
  senseGroup: string
  mcpServers: string[]
  /** 预设工作区快照；缺省表示该会话未限定工作区。 */
  workspace?: string
  /** workspace 当前是否有效；workspace 缺省时不返回。 */
  workspaceValid?: boolean
}

export interface ChatListResponseData {
  chats: Array<{
    chatId: string
    createdAt: number
    updatedAt: number
    messageCount: number
    /**
     * 角色（子 pet）关联主 chat 的 chatId；主 chat 为 null。
     * 前端据此溯源重建 pet 树（主 chat → 主 pet，子 chat 挂主 pet 附近）。CP1。
     */
    parentChatId: string | null
    taskId?: string
    branchId?: string
    branchKind?: ConversationBranchKind
    /** Stable preset workspace identity; legacy chats are resolved by preset name. */
    presetId?: string
    /** Updated only by explicit user input/interaction, never by background output. */
    lastUserActivityAt?: number
    /** 子 chat 的角色 type 与解析后的头像；主 chat 缺省。 */
    agentType?: string
    avatar?: string
    /**
     * 当前 chat 关联的项目工作目录绝对路径（metadata.workspace 快照）。
     * 缺省（非预设 / 预设未配 workspace / 旧 chat）→ undefined → 前端不显示 workspace 标识。
     */
    workspace?: string
    /**
     * workspace 路径当前是否为可访问目录。workspace 缺省时 undefined。
     * 前端据此在 FAB 旁标记失效状态（如警告图标 / 红色）。
     */
    workspaceValid?: boolean
    /**
     * 首条 user 消息截断（≤40 字符），供会话列表辨识。"指令"跳过规则待定（默认取首条 user 消息）。
     * 仅 includePreview=true 时返。CP8。
     */
    preview?: string
    /**
     * user 角色消息数 = 会话轮次。仅 includePreview=true 时返。CP8。
     */
    turnCount?: number
    /**
     * 上下文 token 用量比例（0-1）。仅 includePreview=true 时返（SessionList 渲染用）。
     * = 当前 chat 总 token / brain.contextLimit（见 computeContextUsage）。
     */
    contextUsage?: number
    /**
     * 已用 token 数（估算值，字符数/4）。仅 includePreview=true 时返。配合 contextTotal 显示详情。
     */
    contextUsed?: number
    /**
     * 上下文上限 token 数。仅 includePreview=true 时返。
     */
    contextTotal?: number
    /**
     * 上下文用量 6 段分解（系统/用户系统/记忆/技能/工具定义/用户对话）。仅 includePreview=true 时返。
     */
    contextBreakdown?: ContextBreakdown
    /**
     * 角色是否已完成（metadata.finished 解析）。前端据 finished===true 重建子 pet 为 ghost（灵魂态）。
     * 主 chat 恒 undefined。无论 includePreview 与否都返（initFromChats 重建 pet 树需）。
     */
    finished?: boolean
    /**
     * 子 chat 唤醒策略（metadata.wake，immediate/deferred/barrier）。前端重连识别等待态子 +
     * 后端 rebuildWaitedChildren 已按策略重建唤醒链。主 chat 恒 undefined。
     */
    wake?: 'immediate' | 'deferred' | 'barrier'
    /**
     * 主 chat 有已持久化、尚未由 chat.resume 消费的角色回复。前端重连后据此恢复主循环。
     */
    resumePending?: boolean
    /**
     * 该 chat 的 in-flight sense 审批（approvalManager 内存索引派生，轻量，免 hydration）。
     * 非 null = 有待用户 accept/reject 的审批，供会话列表「琴键」闪烁提示（含未打开/未 hydration 的 chat）；
     * null = 无挂起审批。恒返回（非请求参数；响应未做 schema 校验）。
     * 与 currentState.pendingApproval（computeCurrentState 扫事件重建，单 chat 已 hydration 路径）一致——
     * 同为 approval 生命周期；此处为 chat.list 的第二轻量源。
     * senseName = 待审批感官名；waitTime = 审批窗口 ms（= global.approval_timeout，0 = 不限时）；
     * createdAt = interrupt 触发时间戳（ms），前端倒计时 = waitTime - (now - createdAt)。
     */
    pendingApproval?: {
      approvalId: string
      senseName: string
      waitTime: number
      createdAt: number
    } | null
    /** 待回答问题数量。列表只携带计数；完整问题在打开对应根会话后按需加载。 */
    pendingQuestionCount?: number
    pendingQuestions?: Array<{
      batchId: string
      questionId: string
      header?: string
      question: string
      createdAt: number
    }>
  }>
}

export interface PendingQuestionBatchData {
  batchId: string
  assistantMessageId: string
  createdAt: number
  questions: Array<{
    questionId: string
    position: number
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect: boolean
    createdAt: number
  }>
}

interface QuestionStateSnapshotData {
  /** 与 pendingQuestionBatches 同一 SQLite 读快照中的 chat event 游标。 */
  snapshotSeq: number
  pendingQuestionBatches: PendingQuestionBatchData[]
}

/**
 * 刷新当前态快照（G8）。chat.get / chat.attach / chat.sync response 携带。
 * 给前端权威当前态，避免从事件流推导「审批是否仍存活」「运行中工具」「当前 todo」。
 * 事件流（chat.sync）仍是缓存数组累积水源；本快照仅补事件无法可靠判定的事实。
 */
export interface CurrentStateData {
  /**
   * 仍存活的挂起审批（approvalManager 内存命中，未被 confirm/park/超时清出）。
   * run 已 paused 时省略（前端显继续按钮）。前端据 waitTime+createdAt 算倒计时。
   */
  pendingApproval?: {
    approvalId: string
    senseName: string
    arguments: string
    supervisionLevel: number
    waitTime: number
    createdAt: number
  }
  /** 已发 sense_end/sense_started 但无 accept/rejected 的工具（含待审批）。run 未运行时为空。 */
  runningTools: { id: string; senseName: string }[]
  /** 最近一条 update_todo 的结构化 todos；无则省略。 */
  currentTodo?: unknown[]
}

export interface ChatSessionSnapshotData {
  /** 当前持久化 runtime selection。 */
  runtime?: RuntimeSelection
  /** 主 chat 创建时所选预设。 */
  preset?: string
  /** 当前会话是否可显式继续。 */
  canResume?: boolean
  /** 刷新当前态快照（pending approval / 运行中工具 / 当前 todo）。 */
  currentState?: CurrentStateData
  /** 当前 chat 关联的项目工作目录绝对路径。 */
  workspace?: string
  /** workspace 路径当前是否为可访问目录。 */
  workspaceValid?: boolean
  /** 当前 chat 上下文 token 用量比例（0-1）。 */
  contextUsage?: number
  /** 已用 token 数（估算值）。 */
  contextUsed?: number
  /** 上下文上限 token 数。 */
  contextTotal?: number
  /** 上下文用量 6 段分解。 */
  contextBreakdown?: ContextBreakdown
  /** 当前命令系统配置投影。 */
  commandConfig?: CommandConfigData
}

export interface ChatGetResponseData extends QuestionStateSnapshotData, ChatSessionSnapshotData {
  chatId: string
}

export interface ChatDeleteResponseData {
  chatId: string
}

export interface ChatContextUsageResponseData {
  chatId: string
  contextUsage: number
  /** 已用 token 数（估算值）。 */
  contextUsed: number
  /** 上下文上限 token 数。 */
  contextTotal: number
  /** 上下文用量 6 段分解（系统/用户系统/记忆/技能/工具定义/用户对话）。 */
  contextBreakdown: ContextBreakdown
  /** 当前用户全局命令系统配置。前端据此判断 compact 按钮可见性。 */
  commandConfig?: CommandConfigData
}

/** 单个工具定义快照（chat.promptSnapshot 返回；剥离 provider 差异，统一 OpenAI 形状）。 */
export interface PromptSnapshotTool {
  name: string
  description: string
  /**
   * 参数 JSON schema（object 形状）。前端弱化展示：折叠区 + 字段名/类型/required，
   * 不渲染 schema 全文。缺失（无 parameters 的异常 sense）→ undefined。
   */
  parameters?: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: boolean
  }
}

export interface ChatPromptSnapshotRequestData {
  chatId: string
}

export interface ChatPromptSnapshotResponseData {
  chatId: string
  /** system 消息全文：buildFirstSystemPrompt 重建（<system-reminder>+<environment>+<workspace>+<memory>+<skills>）。 */
  systemPrompt: string
  /** 当前 runtime 启用的全部工具定义（name + description + parameters；含 mcp/memory_manage）。空 runtime → []。 */
  tools: PromptSnapshotTool[]
}

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
export interface ChatInputSubmitResponseData {
  chatId: string
  inputId: string
  clientMessageId: string
  messageId: string
  runId: string
  state: 'started' | 'queued'
  queueSequence: number
  acceptedAt: number
}

export interface ChatTimelineGetRequestData {
  /** Legacy single-chat key. Root timeline clients should send rootChatId. */
  chatId?: string
  rootChatId?: string
  taskId?: string
  view?: 'conversation' | 'tree' | 'audit'
  before?: string
  limit?: number
  knownRevision?: number
}

export interface CanonicalSenseCall {
  id: string
  name: string
  arguments: string
  result?: string
  status?: 'pending' | 'accepted' | 'rejected'
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
  runtime?: RuntimeSelection
  senseCalls?: CanonicalSenseCall[]
  origin?: { parentChatId?: string; childChatId?: string; spawnCallId?: string }
  /** 该消息是 wakeParent 注入的子返回（child_return 链接）。前端据此标 mergedView 从主轴过滤。 */
  childReturn?: boolean
}

export type TimelineActor =
  | { kind: 'user'; actorId: 'human'; displayName?: string }
  | { kind: 'agent'; chatId: string; roleType?: string; avatarKey?: string }
  | { kind: 'tool'; toolName: string }
  | { kind: 'system' }

export type TimelineDirection =
  'user-to-agent' | 'agent-to-user' | 'parent-to-child' | 'child-to-parent' | 'internal'

export interface GraphToolCall {
  callId: string
  index: number
  name: string
  arguments: string
  result?: string
  status: 'pending' | 'accepted' | 'rejected' | 'completed' | 'error'
  childChatId?: string
  targetChatId?: string
}

export interface TerminationFact {
  actor: 'user' | 'system' | 'agent'
  code: 'user_abort' | 'system_stop' | 'watchdog' | 'error' | 'agent_redirect'
  at: number
  detail?: string
  controlOperationId?: string
}

export interface TimelineNode {
  id: string
  rootChatId: string
  sourceChatId: string
  sourceMessageId?: string
  kind: 'message' | 'tool-batch' | 'return' | 'dispatch' | 'system' | 'tool-group' | 'spawn'
  actor: TimelineActor
  target?: TimelineActor
  direction: TimelineDirection
  visibility: 'conversation' | 'detail' | 'internal'
  content: string
  thinking?: string
  /** 消息执行时的 runtime；assistant 继承同 chat 前一条 user 消息的快照。 */
  runtime?: RuntimeSelection
  toolCalls?: GraphToolCall[]
  batchId?: string
  orderKey: number
  termination?: TerminationFact
  /** Legacy read compatibility only. CP2 writers do not populate these fields. */
  parentNodeId?: string
  causationId?: string
  createdAt: number
  updatedAt: number
  status: 'committed' | 'revoked'
  taskId?: string
  branchId?: string
  branchKind?: ConversationBranchKind
  forkAnchor?: boolean
}

export type ExecutionEdgeKind =
  'sequence' | 'spawn' | 'continue' | 'dispatch' | 'return' | 'return-continuation' |
  'fork-continuation' | 'fork-detail'

export interface ExecutionEdgeFact {
  id: string
  rootChatId: string
  fromNodeId: string
  toNodeId: string
  kind: ExecutionEdgeKind
  orderKey: number
  sourceChatId: string
  targetChatId: string
  callId?: string
  taskId?: string
  branchId?: string
}

export interface ActiveRunFact {
  rootChatId: string
  chatId: string
  runId: string
  status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed'
  turnId?: string
  nodeId?: string
  batchId?: string
}

export interface RootTimelineSnapshot {
  rootChatId: string
  taskId?: string
  activeBranchId?: string
  branches?: ConversationBranchSummary[]
  view: 'conversation' | 'tree' | 'audit'
  revision: number
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
  activeRuns: ActiveRunFact[]
  pendingInputs: PendingInputSnapshot[]
  controlState?: TreeControlState
  nextCursor?: string
  capturedEventSeq: number
}

export interface ChatTimelineGetResponseData {
  chatId: string
  revision: number
  messages: CanonicalMessage[]
  rootTimeline?: RootTimelineSnapshot
  nextCursor?: string
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
}

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
}

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

export interface SenseQuestionAnswerResponseData {
  questionId: string
  cancelled: boolean
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

export interface McpListResponseData {
  servers: McpServerInfo[]
}

export interface McpGetResponseData {
  server: McpServerInfo
}

export interface McpConnectResponseData {
  server: McpServerInfo
}

export interface McpDisconnectResponseData {
  server: McpServerInfo
}

/**
 * mcp.reload 返回：全量 server 列表 + 本次操作汇总。
 * - 全量重载：connected/failed/totalSenses 覆盖所有 server。
 * - 单 server 重载：connected∈{0,1}、failed∈{0,1}、totalSenses 为该 server 注册数；servers 为重载后全量列表。
 */
export interface McpReloadResponseData {
  servers: McpServerInfo[]
  connected: number
  failed: number
  totalSenses: number
}

/**
 * config.get 响应：.chery/config.yaml 原文（除 server 段）。
 * supervision 为字符串、key 仍为 $ENV 占位符、无路径补全（供设置面板编辑）。
 */
export type ConfigGetResponseData = ConfigRaw

/**
 * config.save 响应：校验通过已写盘，需重启后端生效。
 * 校验失败走 error（INVALID_PARAMS + errors 列表），不返此 data。
 */
export interface ConfigSaveResponseData {
  needRestart: true
  /** immediate=当前空闲、即将替换 worker；scheduled=等待 chat 空闲；manual=当前 worker 未受守护。 */
  restart: 'immediate' | 'scheduled' | 'manual'
}

/** config.workspace.validate 响应：无副作用的后端目录校验结果。 */
export interface ConfigWorkspaceValidateResponseData {
  valid: boolean
  error?: string
}

/** hooks.get 响应：全局 hooks + 各 brain 级 hooks（只读展示）*/
export interface HooksGetResponseData {
  handlers: Record<string, HooksHandlerDTO[]>
  brainHooks: Record<string, Record<string, HooksHandlerDTO[]>>
}

/** hooks.save 响应：写入成功 */
export interface HooksSaveResponseData {
  ok: true
}

/**
 * utils.models 响应：归一化模型列表。
 * 请求失败时 models 为空数组，error 携带错误信息（非 RpcError，前端可展示）。
 */
export interface UtilsModelsResponseData {
  models: Array<{
    /** 模型 ID（API 原始值） */
    id: string
    /** 显示名（缺省取 id） */
    name?: string
    /** 所有者/组织（部分 API 提供） */
    ownedBy?: string
  }>
  /** 非空时表示请求失败，前端据此展示错误提示 */
  error?: string
}

/** utils.testConnection 响应：判别联合避免 ok 与 error 组合出无效状态。 */
export type UtilsTestConnectionResponseData =
  { ok: true; error?: never } | { ok: false; error: string }

/** env.list 响应：.env 文件中的变量名列表 */
export interface EnvListResponseData {
  vars: string[]
}

/**
 * utils.thinkingLevels 响应：model → ThinkingLevel 列表。
 * 每个 model 一定有 entries（未命中兜底为 `["off", "on"]`）；空 models 入参返回 `levels: {}`。
 * ThinkingLevel 含 `(string & {})`，故 elements 可为任意字符串（如 `.chery/model-thinking.yaml` 里的 `max`）。
 */
export interface UtilsThinkingLevelsResponseData {
  levels: Record<string, import('@/core/llm/adapter.js').ThinkingLevel[]>
}

/** utils.openFile 响应：空（成功即打开，失败返 RpcError） */
export type UtilsOpenFileResponseData = EmptyObjectData

/** utils.openConfigDir 响应：空（成功即打开，失败返 RpcError） */
export type UtilsOpenConfigDirResponseData = EmptyObjectData

/**
 * utils.editors 响应：系统可用的文本编辑器列表。
 * editors：编辑器信息数组（name=显示名，command=启动命令，available=是否可用）。
 */
export interface UtilsEditorsResponseData {
  editors: Array<{
    /** 显示名称（如 "Visual Studio Code"） */
    name: string
    /** 启动命令（如 "code"、"notepad"、"gedit"） */
    command: string
    /** 是否在系统 PATH 中可用 */
    available: boolean
  }>
}

// ========== Chunk Data ==========

export type ChunkData = StreamChunkData | StagedChunkData

export interface StreamChunkData {
  /** 当前 LLM 响应消息 id（checkpoint 预分配，= 最终 messages.id）。 */
  msgId: string
  /** 当前 LLM 响应开始时间。 */
  createdAt: number
  thinking?: string
  content?: string
  senseCall?: SenseCallDelta[]
  /** Anthropic 扩展：thinking blocks 流式增量（每 chunk 触发 0..N 个 delta）；
   *  由 ThinkingBlockAssembler 聚合成完整 blocks 落库 + buildMessages 原样回传。 */
  thinkingBlocksDelta?: ThinkingBlockDelta[]
}

export interface SenseCallDelta {
  index?: number
  id?: string
  name?: string
  arguments?: string
}

export interface StagedChunkData {
  type: 'thinking_end' | 'content_end' | 'sense_end' | 'reverse'
  /** 消息角色，用于区分消息来源（chat.get历史返回时使用） */
  role?: 'user' | 'assistant' | 'system' | 'sense' | 'role' | 'subagent' // role=新（子 pet 回复）；subagent 仅旧历史消息兼容
  thinking?: string
  content?: string
  senseName?: string
  arguments?: string
  /** sense 调用 id（= trigger.id = sense message.id），用于前端关联 sense_end 与 role:sense 的 result content_end */
  id?: string
  /** 消息主键 msgId（= messages.id）。全部 assistant staged 携带；reverse 不携带。 */
  msgId?: string
  /** reverse 类型：被撤回的消息 id 列表（chat.send 恢复撤回整个当前周期时携带） */
  messageIds?: string[]
  /** 感官去重：该消息已被后续相同 hash 调用替换（chat.get 历史返回时携带，content 仍为原内容） */
  replace?: { state: boolean; by: string; content: string }
  /** 被替换时的原内容（溯源/前端展示） */
  originalContent?: string
  /** content_end 携带：user=发送时配置（messages.runtime），assistant=前一条 user runtime（后端关联）。供前端 hover 历史消息显该消息用的 brain/工具 */
  runtime?: RuntimeSelection
  /** 消息创建时间戳（ms），用于合并多 chat 历史时按时间排序 */
  createdAt?: number
  /**
   * 消息来源 chatId（chat.get 历史回放时携带，= 当前回放的 chatId）。
   * 前端反向溯源：filter agentChatId === X 取该 agent 完整 history，无需正向溯源。
   * 旧消息（写入早于本字段）时为 undefined；前端按当前 chatId 兜底。
   */
  agentChatId?: string
  /** true 表示该 assistant 消息是 compact 摘要；历史 UI 据此显示上下文切换边界。 */
  contextCompaction?: boolean
  contextCompactionTokens?: number
}

// ========== Notification Data ==========

export type NotificationData =
  | InterruptNotificationData
  | SenseStartedNotificationData
  | AcceptNotificationData
  | RejectedNotificationData
  | ConsumedNotificationData
  | ErrorNotificationData
  | ReplacedNotificationData
  | RoleCreatedNotificationData
  | RoleDestroyedNotificationData
  | RoleReplyNotificationData
  | ChildAbandonedNotificationData
  | QuestionRequestedNotificationData
  | QuestionAnsweredNotificationData
  | QuestionBatchRequestedNotificationData
  | QuestionBatchCompletedNotificationData
  | DoneNotificationData
  | AutoCompactedNotificationData
  | TimelinePatchData
  | TurnStartedNotificationData
  | TurnDeltaNotificationData
  | TurnCompletedNotificationData
  | InputUpdatedNotificationData
  | RunUpdatedNotificationData
  | InteractionChangedNotificationData
  | null

export interface InteractionChangedNotificationData {
  interactionId: string
  status: InteractionData['status']
  revision: number
}

export interface InterruptNotificationData {
  approvalId: string
  senseName: string
  arguments: string
  supervisionLevel: SupervisionLevel
  needsApproval: boolean
  /** 审批等待时长（ms，= global.approval_timeout）。前端据此与 createdAt 算倒计时。仅 needsApproval=true 时有意义。 */
  waitTime: number
  /** 审批发起时间戳（ms，Date.now()）。前端倒计时 = waitTime - (now - createdAt)。 */
  createdAt: number
}

/**
 * 感官开始执行（sense_end，仅 auto 工具推送；smart/manual 走 interrupt）。
 * 前端据 id 维护「运行中工具」列表（pet bar 右侧显 icon）；accept（approvalId=id）到达时移除。
 * id = SenseTriggerChunk.id（= sense 调用 id，与 accept.approvalId 同源）。
 */
export interface SenseStartedNotificationData {
  id: string
  senseName: string
  arguments: string
}

export interface AcceptNotificationData {
  approvalId: string
  senseName: string
  result: string
}

export interface RejectedNotificationData {
  approvalId: string
  senseName: string
  reason: string
}

export interface ConsumedMessageData {
  id: string
  role: 'user'
  content: string
  createdAt: number
  updateAt: number
  inputId?: string
  clientMessageId?: string
  commandId?: string
}

export interface ConsumedNotificationData {
  count: number
  messages: ConsumedMessageData[]
}

/**
 * chat.send/resume loop 结束（done notification data）。CP7。
 * contextUsage = 当前 chat 总 token / brain.contextLimit（0-1），前端据实时更新 pet.contextUsage。
 */
export interface DoneNotificationData {
  contextUsage: number
  /** 已用 token 数（估算值）。前端据实时更新 pet.contextUsed。 */
  used?: number
  /** 上下文上限 token 数。前端据实时更新 pet.contextTotal。 */
  total?: number
  /** 上下文用量 6 段分解。前端据实时更新 pet.contextBreakdown（分段进度条渲染）。 */
  contextBreakdown: ContextBreakdown
  /**
   * 子 agent done 标记（仅子 chat 即 parent_chat_id 非空时携带=true）。
   * 前端据 finished===true 把子 pet 转 ghost（灵魂态）。主 chat 不带。done 时后端写 metadata.finished 持久化。
   */
  finished?: boolean
  /**
   * 权威 canResume（computeCanResume 派生）：统一暂停语义下，前端据此区分
   * paused（末条非 ended，显继续按钮）/ ended（末条 assistant 无 senseCalls，无按钮），
   * 取代旧 done→canResume=false 硬编码。
   */
  canResume?: boolean
  /**
   * 本轮末条 assistant 消息（仅 loop 结束末条为 assistant 时携带）。
   * 前端据此实时追加进 stream.history —— PetIcons 历史圆点气泡即时显最新回复，
   * 不再等下次 chat.get 重载才补齐（否则圆点长期显旧内容）。
   * msgId = messages.id，供下次 chat.get 合流按 msgId 去重，避免重复。
   * agentChatId = 该消息来源 chatId（默认 = 当前 chat 上下文；冗余携带供前端反向溯源 ——
   * 后续可按 agentChatId filter 取该 agent 完整 history，无需正向溯源）。
   */
  finalMessage?: {
    msgId: string
    role: 'assistant'
    content: string
    thinking?: string
    createdAt: number
    agentChatId?: string
    contextCompaction?: boolean
    contextCompactionTokens?: number
  }
}

export interface ErrorNotificationData {
  message: string
  /**
   * 权威 canResume：AI 报错归 paused（可 resume 重试），前端据此显继续按钮。
   */
  canResume?: boolean
}

/**
 * 自动压缩事件（auto_compacted）。
 * - reason=`usage` → auto 阈值命中（thresholdReached）；`overflow` → used + safety_margin > total。
 * - usedBefore/usedAfter 为本轮开始前后的对话段 token；前端可用 before-after 计算展示「释放 N tokens」。
 * - 此事件**不**单独发「完成」——紧邻的 `done` notification 含最新 contextUsage 作权威值。
 *   收到 auto_compacted 后前端可短暂显 toast（如「已自动压缩」），随后 done 推送刷新 context bar。
 */
export interface AutoCompactedNotificationData {
  reason: 'usage' | 'overflow'
  usedBefore: number
  total: number
}

/**
 * 感官去重命中（read_file hash 相同 = 文件未变动）：
 * 历史 sense 结果被新读取替换。web 据此实时更新对应历史 sense block。
 */
export interface ReplacedNotificationData {
  /** 被替换的历史 sense message id（= sense call id） */
  id: string
  /** 替换后的说明文字（主显，剔除冗长重复内容） */
  content: string
  /** 原长内容（折叠溯源） */
  originalContent: string
  /** 触发替换的新 sense id */
  by: string
}

/**
 * 角色派发（spawn_role sense 执行时推送）。
 * 前端据 type+prompt 创建子 pet 并驱动子 chat（前端驱动架构，见 docs/agent-pet.md §2/§5.1）。
 * 此类异步事件没有 requestId；外层 chatId 为 parentChatId，前端按 chatId 路由。
 */
export interface RoleCreatedNotificationData {
  /** Persisted task id. The client must call chat.startSpawn(taskId), not chat.send directly. */
  taskId: string
  /** 子 chat id（前端据此驱动子 chat.send） */
  chatId: string
  /** 主 chat id（前端溯源 pet 树） */
  parentChatId: string
  /** 角色类型（config.roles 键名） */
  type: string
  /** 角色头像（显式配置或按 type 稳定生成）。 */
  avatar: string
  /** 交付角色的任务 prompt */
  prompt: string
  /** 角色用的 brain 名 */
  brain: string
  /** 角色启用的感官组（单组） */
  senseGroup: string
  /** 唤醒策略（immediate/deferred/barrier，信息性：前端均驱动子跑，唤主时机由后端 wakeScheduler 决定） */
  wake: 'immediate' | 'deferred' | 'barrier'
}

/**
 * 唤醒策略唤主（见 docs/agent-pet.md §5.4 唤醒策略调度器）。
 * wake=immediate 子完成 / 策略满足（wakeScheduler shouldWake=true）时后端推：已把子结果以 role:role 注入主 chat DB，
 * 前端收此 notification → 自动 chat.resume(parentChatId) 跑唤醒轮。deferred/barrier silent 路径不推（静默暂存）。
 * 外层 chatId = parentChatId。
 */
export interface RoleReplyNotificationData {
  /** 主 chat id（前端据此 resume 主） */
  parentChatId: string
  /** 子 chat id */
  childChatId: string
  /** 角色类型（前端展示用） */
  type: string
  /** 角色结果（即时展示；权威内容已注入主 chat DB，role:role） */
  content: string
  /**
   * 触发本次 spawn 的 sense call id（= 主 chat sense message.id）。
   * 前端 F 改动：点击 role 子头像 smooth scroll 回主 chat 的 sense 调用框。
   * 旧 chat 无此字段（写入早于 E 改动）时为 undefined。
   */
  spawnSenseCallId?: string
  /** 注入主 chat 的 role:role 行 msgId（= addMessage 第一参）。前端合流主+子历史时按 msgId 去重。 */
  msgId: string
}

/**
 * 角色销毁（destroy_role sense 执行时推送，CP6）。
 * 前端据 chatId 移除对应子 pet 并关闭子 chat UI。
 * requestId 为主 chat id（与 role_created 同路由规则）。
 */
export interface RoleDestroyedNotificationData {
  /** 被销毁的子 chat id */
  chatId: string
}

/**
 * 看门狗超时掐断（handleAsyncWakeTimeout，wake_on_timeout=true）。
 * 与 role_reply 并列推送：role_reply 负责主唤醒 + 历史注入（[角色 type] 任务已结束...），
 * child_abandoned 仅负责前端子 pet 即时转 ghost 视觉（不等 role_reply 的 WS 投递兜底）。
 * 外层 chatId = parentChatId（与 role_created/role_reply 同路由规则）。
 */
export interface ChildAbandonedNotificationData {
  /** 主 chat id（前端溯源 pet 树） */
  parentChatId: string
  /** 被掐断的子 chat id（前端据 chatId 找子 pet 转 ghost） */
  childChatId: string
  /** 角色类型（前端展示用） */
  type: string
  /** 掐断原因（如「子任务执行超时（30s 无输出）」；信息性，不进主 chat 历史） */
  reason: string
}

/** 旧版逐题提问事件，仅保留历史协议兼容。 */
export interface QuestionRequestedNotificationData {
  questionId: string
  senseName: 'ask_user_question'
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  /** 等待时长（ms，= global.approval_timeout）。0 = 不超时。 */
  waitTime: number
  /** 发起时间戳（ms，Date.now()）。前端倒计时 = waitTime - (now - createdAt)。 */
  createdAt: number
}

/** 旧版逐题完成事件，仅保留历史协议兼容。 */
export interface QuestionAnsweredNotificationData {
  questionId: string
  /** 可选答案文本（权威内容已写入 sense content；此字段仅作即时展示/日志） */
  answer?: string
}

/** 后端持久化完成后发出的完整问题批次；事件可安全重放且按 batchId 幂等。 */
export interface QuestionBatchRequestedNotificationData extends PendingQuestionBatchData {}

/** 批次原子提交完成。仅用于清理客户端投影；是否 resume 由 batchAnswer RPC 响应决定。 */
export interface QuestionBatchCompletedNotificationData {
  batchId: string
}

// ========== Error ==========

export interface RpcError {
  code: string
  message: string
}

// ========== 方法常量 ==========

export const Method = {
  // Brain / Sense 列表
  BRAIN_LIST: 'brain.list',
  SENSE_LIST: 'sense.list',
  // 列出代码维护的全部内置工具（name/label/description），供设置面板感官分组下拉
  SENSE_TOOLS: 'sense.tools',
  // 实时列出用户配置目录中的 Skill 元数据，供发送窗口 / 命令菜单使用
  SKILLS_LIST: 'skills.list',
  // 轻量接口：仅返回 skill/plugin 名称列表（不算 token），供角色卡下拉
  SKILLS_LIST_NAMES: 'skills.listNames',
  // Skill 导入：preImport 拉分支 + 探测鉴权/git；importUrl 选分支 clone 到 staging 分析候选；commit 落盘（写来源索引）；delete 删独立 skill（清索引）；listSources/resyncSource/deleteSource 管 git 来源中央索引
  SKILLS_PRE_IMPORT_URL: 'skills.preImportUrl',
  SKILLS_IMPORT_URL: 'skills.importUrl',
  SKILLS_COMMIT: 'skills.commit',
  SKILLS_DELETE: 'skills.delete',
  SKILLS_LIST_SOURCES: 'skills.listSources',
  SKILLS_CHECK_SOURCE: 'skills.checkSource',
  SKILLS_CHECK_ALL_SOURCES: 'skills.checkAllSources',
  SKILLS_RESYNC_SOURCE: 'skills.resyncSource',
  SKILLS_DELETE_SOURCE: 'skills.deleteSource',
  // 批量重拉全部 Skill 来源（非交互：serial 串行；写 lastSyncError 持久化失败 marker）
  SKILLS_RESYNC_ALL_SOURCES: 'skills.resyncAllSources',
  // 递归列出 .chery/prompt/ 下全部 .md（含子文件夹，排除 system.md），供设置面板 systemPrompt 级联选择器
  PROMPTS_LIST: 'prompts.list',
  // 列出 .chery/rule/ 下全部 .yaml（排除基准 base.yaml），供设置面板预设「规则文件」下拉
  RULES_LIST: 'rules.list',

  // Runtime 设置（每轮可换，必须原子携带 brain + senseGroups）
  RUNTIME_SET: 'runtime.set',
  // 当前会话临时角色编制（不持久化）
  SESSION_RUNTIME_SET: 'session.runtime.set',

  // Chat 管理
  CHAT_CREATE: 'chat.create',
  CHAT_LIST: 'chat.list',
  CHAT_ROUTE_SUGGEST: 'chat.route.suggest',
  CHAT_GET: 'chat.get',
  CHAT_DELETE: 'chat.delete',
  CHAT_BRANCH_PREVIEW: 'chat.branch.preview',
  CHAT_BRANCH_CREATE: 'chat.branch.create',
  CHAT_BRANCH_ACTIVATE: 'chat.branch.activate',
  CHAT_ABORT_TASK: 'chat.abortTask',
  CHAT_CONTEXT_USAGE: 'chat.contextUsage',
  /** 重建 chat 当前 runtime 的 system prompt 全文 + 工具定义，供前端历史抽屉「上下文」hover 面板展示。 */
  CHAT_PROMPT_SNAPSHOT: 'chat.promptSnapshot',
  CHAT_SEND: 'chat.send',
  CHAT_INPUT_SUBMIT: 'chat.input.submit',
  CHAT_TIMELINE_GET: 'chat.timeline.get',
  CHAT_RESUME: 'chat.resume',
  CHAT_RESUME_TREE: 'chat.resumeTree',
  CHAT_SYNC: 'chat.sync',
  CHAT_OPEN: 'chat.open',
  CHAT_CLOSE: 'chat.close',
  CHAT_START_SPAWN: 'chat.startSpawn',
  CHAT_STOP_CHILD: 'chat.stopChild',
  CHAT_SEND_TO_CHILD: 'chat.sendToChild',

  // Sense 审批
  SENSE_APPROVAL: 'sense.approval',
  INTERACTION_LIST: 'interaction.list',
  INTERACTION_APPROVAL_DECIDE: 'interaction.approval.decide',
  INTERACTION_QUESTION_ANSWER: 'interaction.question.answer',
  // Sense 问答（ask_user_question 感官答案回传）
  SENSE_QUESTION_ANSWER: 'sense.question.answer',
  SENSE_QUESTION_BATCH_ANSWER: 'sense.question.batchAnswer',
  // Chat 中止（切换 chat：清内存 + 退出挂起 generator，不动 DB，pending 保留供下次重新审核）
  CHAT_ABORT: 'chat.abort',
  // Chat 重连（F5 后重连运行中 run，重定向后续实时输出到本连接）
  CHAT_ATTACH: 'chat.attach',

  // Bash 进程管理（挂起子进程的查询 / 显式杀死）
  BASH_LIST: 'bash.list',
  BASH_KILL: 'bash.kill',

  // MCP 管理（连接层热重载：list/get/connect/disconnect/reload）
  MCP_LIST: 'mcp.list',
  MCP_GET: 'mcp.get',
  MCP_CONNECT: 'mcp.connect',
  MCP_DISCONNECT: 'mcp.disconnect',
  MCP_RELOAD: 'mcp.reload',

  // Config 设置（读写 .chery/config.yaml，除 server 段，重启生效）
  CONFIG_GET: 'config.get',
  CONFIG_WORKSPACE_VALIDATE: 'config.workspace.validate',
  CONFIG_SAVE: 'config.save',

  // Hooks 管理（读写 .chery/hooks/hooks.json，独立于 config.yaml）
  HOOKS_GET: 'hooks.get',
  HOOKS_SAVE: 'hooks.save',
  HOOKS_EVENTS: 'hooks.events',

  // Utils 工具（独立信息查询，不依赖 chat/brain 运行时）
  UTILS_MODELS: 'utils.models',
  UTILS_TEST_CONNECTION: 'utils.testConnection',

  // Env 环境变量（读 .env 变量名列表，供前端密钥下拉）
  ENV_LIST: 'env.list',

  // 打开文件（用配置的编辑器或系统默认）
  UTILS_OPEN_FILE: 'utils.openFile',

  // 固定打开后端主机的 .chery 配置目录
  UTILS_OPEN_CONFIG_DIR: 'utils.openConfigDir',

  // 编辑器列表（获取系统可用的文本编辑器）
  UTILS_EDITORS: 'utils.editors',

  // 模型档位（按 model 名批量查 ThinkingLevel，前端旋钮用）
  UTILS_THINKING_LEVELS: 'utils.thinkingLevels',

  // 内置命令管理（settings 「指令」tab 后端；只读枚举 .chery/command/*.md，不可增删改）
  COMMAND_LIST: 'command.list',

  // 插件管理（settings 「插件」tab 后端）：GitHub URL git clone（分支选择 + 凭据池 + 版本检查）
  PLUGINS_LIST: 'plugins.list',
  PLUGINS_PRE_IMPORT_URL: 'plugins.preImportUrl',
  PLUGINS_IMPORT_URL: 'plugins.importUrl',
  PLUGINS_COMMIT: 'plugins.commit',
  PLUGINS_CHECK_UPDATE: 'plugins.checkUpdate',
  PLUGINS_CHECK_ALL_UPDATES: 'plugins.checkAllUpdates',
  PLUGINS_UPDATE: 'plugins.update',
  PLUGINS_UNINSTALL: 'plugins.uninstall',

  // 凭据池（通用：plugins / skills / 未来 commands 共享；密令后端加密存储，list 不回密令）
  CREDENTIALS_LIST: 'credentials.list',
  CREDENTIALS_SAVE: 'credentials.save',
  CREDENTIALS_DELETE: 'credentials.delete',
} as const

/**
 * Method 类型别名：所有合法 method 字符串的联合。
 * Request.method 用此类型（非裸 string），router.register 据 Method 约束注册键。
 */
export type Method = (typeof Method)[keyof typeof Method]

/**
 * RPC 方法级契约：Method 与 params/result 保持一一对应。
 * RequestData/ResponseData 仅是动态传输边界的派生联合；业务 handler 使用 ParamsOf/ResultOf。
 */
export interface RpcMethodMap {
  [Method.BRAIN_LIST]: { params: BrainListRequestData; result: BrainListResponseData }
  [Method.SENSE_LIST]: { params: SenseListRequestData; result: SenseListResponseData }
  [Method.SENSE_TOOLS]: { params: SenseToolsRequestData; result: SenseToolsResponseData }
  [Method.SKILLS_LIST]: { params: SkillsListRequestData; result: SkillsListResponseData }
  [Method.SKILLS_LIST_NAMES]: {
    params: SkillsListNamesRequestData
    result: SkillsListNamesResponseData
  }
  [Method.SKILLS_PRE_IMPORT_URL]: {
    params: SkillsPreImportUrlRequestData
    result: SkillsPreImportUrlResponseData
  }
  [Method.SKILLS_IMPORT_URL]: {
    params: SkillsImportUrlRequestData
    result: SkillsImportUrlResponseData
  }
  [Method.SKILLS_COMMIT]: { params: SkillsCommitRequestData; result: SkillsCommitResponseData }
  [Method.SKILLS_DELETE]: { params: SkillsDeleteRequestData; result: SkillsDeleteResponseData }
  [Method.SKILLS_LIST_SOURCES]: {
    params: SkillsListSourcesRequestData
    result: SkillsListSourcesResponseData
  }
  [Method.SKILLS_CHECK_SOURCE]: {
    params: SkillsCheckSourceRequestData
    result: SkillsCheckSourceResponseData
  }
  [Method.SKILLS_CHECK_ALL_SOURCES]: {
    params: SkillsCheckAllSourcesRequestData
    result: SkillsCheckAllSourcesResponseData
  }
  [Method.SKILLS_RESYNC_SOURCE]: {
    params: SkillsResyncSourceRequestData
    result: SkillsResyncSourceResponseData
  }
  [Method.SKILLS_DELETE_SOURCE]: {
    params: SkillsDeleteSourceRequestData
    result: SkillsDeleteSourceResponseData
  }
  [Method.SKILLS_RESYNC_ALL_SOURCES]: {
    params: SkillsResyncAllSourcesRequestData
    result: SkillsResyncAllSourcesResponseData
  }
  [Method.PROMPTS_LIST]: { params: PromptsListRequestData; result: PromptsListResponseData }
  [Method.RULES_LIST]: { params: RulesListRequestData; result: RulesListResponseData }
  [Method.RUNTIME_SET]: { params: RuntimeSetRequestData; result: RuntimeSetResponseData }
  [Method.SESSION_RUNTIME_SET]: {
    params: SessionRuntimeSetRequestData
    result: SessionRuntimeSetResponseData
  }
  [Method.CHAT_CREATE]: { params: ChatCreateRequestData; result: ChatCreateResponseData }
  [Method.CHAT_LIST]: { params: ChatListRequestData; result: ChatListResponseData }
  [Method.CHAT_ROUTE_SUGGEST]: {
    params: ChatRouteSuggestRequestData
    result: ChatRouteSuggestResponseData
  }
  [Method.CHAT_GET]: { params: ChatGetRequestData; result: ChatGetResponseData }
  [Method.CHAT_DELETE]: { params: ChatDeleteRequestData; result: ChatDeleteResponseData }
  [Method.CHAT_BRANCH_PREVIEW]: { params: ChatBranchPreviewRequestData; result: ChatBranchPreviewResponseData }
  [Method.CHAT_BRANCH_CREATE]: { params: ChatBranchCreateRequestData; result: ChatBranchCreateResponseData }
  [Method.CHAT_BRANCH_ACTIVATE]: { params: ChatBranchActivateRequestData; result: ChatBranchActivateResponseData }
  [Method.CHAT_ABORT_TASK]: { params: ChatAbortTaskRequestData; result: ChatAbortTaskResponseData }
  [Method.CHAT_CONTEXT_USAGE]: {
    params: ChatContextUsageRequestData
    result: ChatContextUsageResponseData
  }
  [Method.CHAT_PROMPT_SNAPSHOT]: {
    params: ChatPromptSnapshotRequestData
    result: ChatPromptSnapshotResponseData
  }
  [Method.CHAT_SEND]: { params: ChatSendRequestData; result: ChatSendResponseData }
  [Method.CHAT_INPUT_SUBMIT]: {
    params: ChatInputSubmitRequestData
    result: ChatInputSubmitResponseData
  }
  [Method.CHAT_TIMELINE_GET]: {
    params: ChatTimelineGetRequestData
    result: ChatTimelineGetResponseData
  }
  [Method.CHAT_RESUME]: { params: ChatResumeRequestData; result: ChatResumeResponseData }
  [Method.CHAT_RESUME_TREE]: {
    params: ChatResumeTreeRequestData
    result: ChatResumeTreeResponseData
  }
  [Method.CHAT_SYNC]: { params: ChatSyncRequestData; result: ChatSyncResponseData }
  [Method.CHAT_OPEN]: { params: ChatOpenRequestData; result: ChatOpenResponseData }
  [Method.CHAT_CLOSE]: { params: ChatCloseRequestData; result: ChatCloseResponseData }
  [Method.CHAT_START_SPAWN]: {
    params: ChatStartSpawnRequestData
    result: ChatStartSpawnResponseData
  }
  [Method.CHAT_STOP_CHILD]: {
    params: ChatStopChildRequestData
    result: ChatStopChildResponseData
  }
  [Method.CHAT_SEND_TO_CHILD]: {
    params: ChatSendToChildRequestData
    result: ChatSendToChildResponseData
  }
  [Method.SENSE_APPROVAL]: { params: SenseApprovalRequestData; result: SenseApprovalResponseData }
  [Method.INTERACTION_LIST]: {
    params: InteractionListRequestData
    result: InteractionListResponseData
  }
  [Method.INTERACTION_APPROVAL_DECIDE]: {
    params: InteractionApprovalDecideRequestData
    result: InteractionApprovalDecideResponseData
  }
  [Method.INTERACTION_QUESTION_ANSWER]: {
    params: InteractionQuestionAnswerRequestData
    result: InteractionQuestionAnswerResponseData
  }
  [Method.SENSE_QUESTION_ANSWER]: {
    params: SenseQuestionAnswerRequestData
    result: SenseQuestionAnswerResponseData
  }
  [Method.SENSE_QUESTION_BATCH_ANSWER]: {
    params: SenseQuestionBatchAnswerRequestData
    result: SenseQuestionBatchAnswerResponseData
  }
  [Method.CHAT_ABORT]: { params: ChatAbortRequestData; result: ChatAbortResponseData }
  [Method.CHAT_ATTACH]: { params: ChatAttachRequestData; result: ChatAttachResponseData }
  [Method.BASH_LIST]: { params: BashListRequestData; result: BashListResponseData }
  [Method.BASH_KILL]: { params: BashKillRequestData; result: BashKillResponseData }
  [Method.MCP_LIST]: { params: McpListRequestData; result: McpListResponseData }
  [Method.MCP_GET]: { params: McpGetRequestData; result: McpGetResponseData }
  [Method.MCP_CONNECT]: { params: McpConnectRequestData; result: McpConnectResponseData }
  [Method.MCP_DISCONNECT]: { params: McpDisconnectRequestData; result: McpDisconnectResponseData }
  [Method.MCP_RELOAD]: { params: McpReloadRequestData; result: McpReloadResponseData }
  [Method.CONFIG_GET]: { params: ConfigGetRequestData; result: ConfigGetResponseData }
  [Method.CONFIG_WORKSPACE_VALIDATE]: {
    params: ConfigWorkspaceValidateRequestData
    result: ConfigWorkspaceValidateResponseData
  }
  [Method.CONFIG_SAVE]: { params: ConfigSaveRequestData; result: ConfigSaveResponseData }
  [Method.HOOKS_GET]: { params: HooksGetRequestData; result: HooksGetResponseData }
  [Method.HOOKS_SAVE]: { params: HooksSaveRequestData; result: HooksSaveResponseData }
  [Method.HOOKS_EVENTS]: { params: HooksEventsRequestData; result: HooksEventsResponseData }
  [Method.UTILS_MODELS]: { params: UtilsModelsRequestData; result: UtilsModelsResponseData }
  [Method.UTILS_TEST_CONNECTION]: {
    params: UtilsTestConnectionRequestData
    result: UtilsTestConnectionResponseData
  }
  [Method.ENV_LIST]: { params: EnvListRequestData; result: EnvListResponseData }
  [Method.UTILS_OPEN_FILE]: { params: UtilsOpenFileRequestData; result: UtilsOpenFileResponseData }
  [Method.UTILS_OPEN_CONFIG_DIR]: {
    params: UtilsOpenConfigDirRequestData
    result: UtilsOpenConfigDirResponseData
  }
  [Method.UTILS_EDITORS]: { params: UtilsEditorsRequestData; result: UtilsEditorsResponseData }
  [Method.UTILS_THINKING_LEVELS]: {
    params: UtilsThinkingLevelsRequestData
    result: UtilsThinkingLevelsResponseData
  }
  [Method.COMMAND_LIST]: { params: EmptyObjectData; result: CommandListResponseData }
  [Method.PLUGINS_LIST]: { params: PluginsListRequestData; result: PluginsListResponseData }
  [Method.PLUGINS_PRE_IMPORT_URL]: {
    params: PluginsPreImportUrlRequestData
    result: PluginsPreImportUrlResponseData
  }
  [Method.PLUGINS_IMPORT_URL]: {
    params: PluginsImportUrlRequestData
    result: PluginsImportUrlResponseData
  }
  [Method.PLUGINS_COMMIT]: { params: PluginsCommitRequestData; result: PluginsCommitResponseData }
  [Method.PLUGINS_CHECK_UPDATE]: {
    params: PluginsCheckUpdateRequestData
    result: PluginsCheckUpdateResponseData
  }
  [Method.PLUGINS_CHECK_ALL_UPDATES]: {
    params: PluginsCheckAllUpdatesRequestData
    result: PluginsCheckAllUpdatesResponseData
  }
  [Method.PLUGINS_UPDATE]: { params: PluginsUpdateRequestData; result: PluginsUpdateResponseData }
  [Method.PLUGINS_UNINSTALL]: {
    params: PluginsUninstallRequestData
    result: PluginsUninstallResponseData
  }
  [Method.CREDENTIALS_LIST]: {
    params: CredentialsListRequestData
    result: CredentialsListResponseData
  }
  [Method.CREDENTIALS_SAVE]: {
    params: CredentialsSaveRequestData
    result: CredentialsSaveResponseData
  }
  [Method.CREDENTIALS_DELETE]: {
    params: CredentialsDeleteRequestData
    result: CredentialsDeleteResponseData
  }
}

export type ParamsOf<M extends Method> = RpcMethodMap[M]['params']
export type ResultOf<M extends Method> = RpcMethodMap[M]['result']
export type RequestData = ParamsOf<Method>
export type ResponseData = ResultOf<Method>

// ========== 错误码常量 ==========

export const ErrorCode = {
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INTERNAL: 'INTERNAL',
  TIMEOUT: 'TIMEOUT',
  // MCP 管理：资源不存在 / 参数非法（handler 显式返回，非抛错走 INTERNAL）
  NOT_FOUND: 'NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  /** 资源当前状态不允许该操作，例如用旧 runId 中止已替换的新运行。 */
  CONFLICT: 'CONFLICT',
} as const

// ========== 工厂函数 ==========

export function createResponse<TData extends ResponseData = ResponseData>(
  requestId: string,
  success: boolean,
  data?: TData,
  error?: RpcError,
): Response<TData> {
  return {
    id: randomUUID(),
    kind: 'response',
    requestId,
    success,
    data,
    error,
  }
}

export function createChunk(
  type: 'stream' | 'staged',
  requestId: string,
  data: ChunkData,
  context: EventContext = {},
): Chunk {
  return {
    kind: 'chunk',
    type,
    requestId,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    data,
  }
}

export function createNotification(
  type: NotificationType,
  requestId: string | undefined,
  data: NotificationData,
  context: EventContext = {},
): Notification {
  return {
    kind: 'notification',
    type,
    ...(requestId ? { requestId } : {}),
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    data,
  }
}

export function createError(code: string, message: string): RpcError {
  return { code, message }
}

// ========== 类型守卫 ==========

export function isRequest(msg: unknown): msg is Request {
  return typeof msg === 'object' && msg !== null && (msg as { kind?: string }).kind === 'request'
}

export function isResponse(msg: unknown): msg is Response {
  return typeof msg === 'object' && msg !== null && (msg as { kind?: string }).kind === 'response'
}
