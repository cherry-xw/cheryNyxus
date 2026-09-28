import type { SupervisionLevel } from '@/core/config.js'
import type { ContextBreakdown } from '@/utils/token.js'
import type {
  RunErrorNotificationData as ProtocolRunErrorNotificationData,
  RunOutcomeNotificationData as ProtocolRunOutcomeNotificationData,
  NoticeNotificationData as ProtocolNoticeNotificationData,
} from '@chery/protocol'
import type { TerminalEventNotificationData } from './terminal.js'
import type {
  InteractionData,
  TaskOverview,
  ToolAuthorization,
  PendingQuestionBatchData,
  TimelinePatchData,
  TurnStartedNotificationData,
  TurnDeltaNotificationData,
  TurnCancelledNotificationData,
  TurnCompletedNotificationData,
  InputUpdatedNotificationData,
  RunUpdatedNotificationData,
} from '../types.js'

// ========== Notification Data ==========

export type NotificationData =
  | import('@chery/protocol').WorkflowUpdated
  | import('@chery/protocol').ChatLifecycleChanged
  | import('@chery/protocol').ConfigApplyState
  | InterruptNotificationData
  | SenseStartedNotificationData
  | AcceptNotificationData
  | RejectedNotificationData
  | ConsumedNotificationData
  | ErrorNotificationData
  | RunOutcomeNotificationData
  | NoticeNotificationData
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
  | TurnCancelledNotificationData
  | TurnCompletedNotificationData
  | InputUpdatedNotificationData
  | RunUpdatedNotificationData
  | InteractionChangedNotificationData
  | ChatOverviewChangedNotificationData
  | TerminalEventNotificationData
  | null

export interface InteractionChangedNotificationData {
  interactionId: string
  status: InteractionData['status']
  revision: number
  presetId?: string
  interaction?: InteractionData
}

export interface ChatOverviewChangedNotificationData {
  subscriptionId: string
  revision: number
  changes: Array<
    | { type: 'upsert'; rootChatId: string; task: TaskOverview }
    | { type: 'remove'; rootChatId: string }
  >
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
  security?: ToolAuthorization
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
  /** 工具真正开始执行的时间戳（ms）；旧事件可省略。 */
  startedAt?: number
  /** 本次执行的最终安全授权判定（authorizeToolCall 输出；缺省 = 无判定，兼容旧客户端） */
  security?: ToolAuthorization
}

export interface AcceptNotificationData {
  approvalId: string
  senseName: string
  result: string
  /** 工具结束时间戳（ms）；旧事件可省略。 */
  completedAt?: number
}

export interface RejectedNotificationData {
  approvalId: string
  senseName: string
  reason: string
  /** 拒绝决定或执行前拒绝的时间戳（ms）；旧事件可省略。 */
  completedAt?: number
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
  /** root loop 结束时间戳（ms）；旧事件可省略。 */
  completedAt?: number
  /** 服务端时钟校准点；与既有 Lite done 投影字段一致，旧客户端可忽略。 */
  serverNow?: number
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

export type ErrorNotificationData = ProtocolRunErrorNotificationData
export type RunOutcomeNotificationData = ProtocolRunOutcomeNotificationData
export type NoticeNotificationData = ProtocolNoticeNotificationData

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
 * 前端据 type+prompt 创建子 pet 并驱动子 chat（前端驱动架构，见 docs/shared/architecture/agent-orchestration.md §2/§5.1）。
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
 * 唤醒策略唤主（见 docs/shared/architecture/agent-orchestration.md §5.4 唤醒策略调度器）。
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
