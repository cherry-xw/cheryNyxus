import type { ThinkingBlockDelta } from '@/core/message/adapter.js'
import type { RuntimeProvenance } from '@/agent/runtimeResolver.js'
import type { StagedReverseChunkData as ProtocolStagedReverseChunkData } from '@chery/protocol'
import type {
  Method,
  ParamsOf,
  ResponseData,
  RpcError,
  ToolAuthorization,
  RouteChunkData,
} from '../types.js'
import type { NotificationData } from './notification.js'

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

/** Cursor and subscription fields shared by streamed and pushed chat events. */
export interface EventEnvelopeBase {
  /** 事件所属 chat；不能从 requestId 推断。 */
  chatId?: string
  /** 一次运行的稳定标识。 */
  runId?: string
  /** 可恢复的会话事件序号。 */
  seq?: number
  /** V2 会话事件序号。 */
  eventSeq?: number
  /** 接收此事件的会话订阅。 */
  subscriptionId?: string
  /** 根树订阅拥有者。 */
  rootChatId?: string
  /** 根树递增序号。 */
  rootEventSeq?: number
  /** 原会话事件序号。 */
  sourceEventSeq?: number
  /** 不占用持久游标的临时事件。 */
  transient?: boolean
}

/** Chunk消息（S→C，流式增量）。 */
export interface Chunk extends EventEnvelopeBase {
  kind: 'chunk'
  type: 'stream' | 'staged' | 'route'
  requestId: string
  data: ChunkData
}

/**
 * Notification消息（S→C，服务端推送）
 */
export interface Notification extends EventEnvelopeBase {
  kind: 'notification'
  type: NotificationType
  /** 触发该事件的 RPC 请求；脱离请求异步推送时省略。 */
  requestId?: string
  data: NotificationData
}

/** Chunk/Notification 共用的显式业务关联字段。 */
export interface EventContext {
  chatId?: string
  runId?: string
}

export type NotificationType =
  | 'config.apply.changed'
  | 'interrupt' // 感官审批请求（sense_end，仅 smart/manual）
  | 'sense_started' // 感官开始执行（sense_end，仅 auto；前端维护「运行中工具」列表）
  | 'accept' // 感官执行成功（全工具；approvalId=sense id，前端移除运行中工具同 id 项）
  | 'rejected' // 感官执行被拒绝
  | 'consumed' // 消息已消费
  | 'loaded' // 历史对话已载入
  | 'done' // 执行完成
  | 'error' // 错误
  | 'run.outcome' // 权威运行终态；done/error 仅为兼容旧客户端
  | 'notice' // 非终态用户提醒
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
  | 'turn.cancelled'
  | 'turn.completed'
  | 'input.updated'
  | 'run.updated'
  | 'interaction.changed'
  | 'chat.lifecycle.changed'
  | 'chat.overview.changed'
  | 'terminal.event'

// ========== Chunk Data ==========

export type ChunkData = StreamChunkData | StagedChunkData | RouteChunkData

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
  messageIds?: ProtocolStagedReverseChunkData['messageIds']
  /** 感官去重：该消息已被后续相同 hash 调用替换（chat.get 历史返回时携带，content 仍为原内容） */
  replace?: { state: boolean; by: string; content: string }
  /** 被替换时的原内容（溯源/前端展示） */
  originalContent?: string
  /** content_end 携带：user=发送时配置（messages.runtime），assistant=前一条 user runtime（后端关联）。供前端 hover 历史消息显该消息用的 brain/工具；brainModel/brainProvider 为溯源快照 */
  runtime?: RuntimeProvenance
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
  /** sense_end 携带：工具调用的安全授权判定（checkpoint 从 trigger 透传，供历史回放渲染风险徽章） */
  security?: ToolAuthorization
}
