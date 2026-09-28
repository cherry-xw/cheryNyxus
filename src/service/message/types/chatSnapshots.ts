import type { ContextBreakdown } from '@/utils/token.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import type { ToolAuthorization } from '@/core/security/rolePolicy.js'
import type { CommandConfigData, ConversationBranchKind } from '../types.js'

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
  /** 空白复用命中标记：true = 未新建，直接返回了同预设既有的空会话（brain/senseGroup/mcpServers 为该会话持久化快照回显）。新建路径缺省不返回。 */
  reused?: boolean
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
    /** Current immutable runtime epoch; only this epoch may execute. */
    activeEpochId?: string
    epochCount?: number
    lifecycle?: 'active' | 'retired' | 'abandoned' | 'archived'
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
  /** 仅 scope='preset' 且携带 limit 时返回：同 WHERE（含分支排除）的匹配总数，供分页判断是否还有更多。 */
  total?: number
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

export interface QuestionStateSnapshotData {
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
    security?: ToolAuthorization
  }
  /** 已发 sense_end/sense_started 但无 accept/rejected 的工具（含待审批）。run 未运行时为空。 */
  runningTools: { id: string; senseName: string }[]
  /** 从持久 chat events 重建的当前 run 模型轮次与真实工具执行步骤。 */
  executionSteps: ExecutionStep[]
  /** 当前活动 run 的持久开始时间；供 chat.open 复用，避免重复扫描事件。 */
  runTiming?: { runId: string; startedAt: number }
  /** 最近一条 update_todo 的结构化 todos；无则省略。 */
  currentTodo?: unknown[]
}

/** 当前执行窗口中的可计时步骤；可由持久 chat events 完整重建。 */
export interface ExecutionStep {
  id: string
  runId: string
  chatId: string
  kind: 'model' | 'tool'
  name: string
  status: 'running' | 'completed' | 'failed' | 'rejected' | 'cancelled'
  startedAt: number
  completedAt?: number
}

export interface ChatSessionSnapshotData {
  /** 历史执行时保存的 runtime，仅用于展示，不参与新一轮运行时解析。 */
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
  /** 当前命令系统配置投影。 */
  commandConfig?: CommandConfigData
}

export interface ChatGetResponseData extends QuestionStateSnapshotData, ChatSessionSnapshotData {
  chatId: string
}

export interface ChatDeleteResponseData {
  chatId: string
  /** Authoritative set removed by the service, including cascaded descendants. */
  deletedChatIds: string[]
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
  /** Omit for the current executable epoch; historical epochs are read-only. */
  epochId?: string
}

export interface ChatPromptSnapshotResponseData {
  origin?: 'frozen' | 'reconstructed' | 'missing'
  contentState?: 'available' | 'partial' | 'missing'
  chatId: string
  epochId?: string
  epochOrdinal?: number
  epochStatus?: 'active' | 'historical' | 'archived'
  snapshotQuality?: 'exact' | 'partial' | 'reconstructed'
  /** system 消息全文：buildFirstSystemPrompt 重建（<system-reminder>+<environment>+<workspace>+<memory>+<skills>）。 */
  systemPrompt: string
  /** 当前 runtime 启用的全部工具定义（name + description + parameters；含 mcp/memory_manage）。空 runtime → []。 */
  tools: PromptSnapshotTool[]
}

export interface ChatEpochListRequestData {
  chatId: string
}

export interface ChatEpochListResponseData {
  chatId: string
  rootChatId: string
  activeEpochId?: string
  epochs: Array<{
    epochId: string
    ordinal: number
    label: string
    status: 'active' | 'historical' | 'archived'
    snapshotQuality: 'exact' | 'partial' | 'reconstructed'
    transitionReason: string
    handoffSummary?: string
    executable: boolean
    createdAt: number
    closedAt?: number
  }>
}
