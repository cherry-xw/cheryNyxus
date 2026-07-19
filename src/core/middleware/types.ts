import type { MessageProviderAdapterConfig, LLMResponse, ReplaceInfo } from '../message/adapter'
import type { LLMAdapter } from '../llm/adapter'
import type { SenseAdapter, SenseCallData, SenseFunction } from '../sense/adapter'
import type { SenseResult, SenseSharedData, SenseRuntimeContext } from '../sense/senseCreator'
import type { GlobalConfig, BrainConfig } from '@/utils/config'
import type { Logger } from '@/utils/logger/types.js'
import type { MessageJournal } from './messageJournal.js'
import { SupervisionLevel } from '../config.js'

export type { LLMAdapter } from '../llm/adapter'

/**
 * 用户输入条目
 */
export interface UserInputEntry {
  content: string
  time: number
}

/**
 * 聊天上下文分组
 * chatId 唯一标识聊天，brain/senseGroups 每轮可换（运行时由 service 层重建 Middleware）
 */
export interface SoulGroup {
  /** 聊天唯一标记（每轮可换 brain/sense，chatId 不变） */
  chatId: string
  /** Sense间共享数据（namespace → identifier → data） */
  senseSharedData: Map<string, Map<string, unknown>>
  /** 用户输入队列（send 事件注入） */
  userInputs: UserInputEntry[]
  /** AI message 参数（checkpoint 构建后放置） */
  messages?: LLMResponse[]
  /** 续接标志：chat.resume Case1（末尾有 pending sense）首轮 senseMiddleware 检测后 skip chat 层 */
  resumePending?: boolean
  /**
   * 父 chat 正在运行时收到新的子任务结果。loop 在当前 LLM 调用结束后据此继续一轮，
   * 防止并发 child_done 被随后追加的 assistant 消息掩盖。
   */
  roleReplyPending?: boolean
  /**
   * yield turn 标志：spawn_role wait=true 置位，请求 loop 本轮 runChain 后立即结束本 turn
   * （子完成后后端注入角色回复唤起新一轮，见 docs/agent-pet.md §5.4）。loop stop-decision 读取。
   */
  yieldTurn?: boolean
}

/**
 * 感官运行时条目（senseTable 的 value）
 * 替代 SenseManager.get(name).supervisionLevel 与 execute(name, args)
 */
export interface SenseEntry {
  /** 监管等级（优先级链已前置计算：感官定义 > sense_group > global） */
  supervisionLevel: SupervisionLevel
  /** 执行器（args 已擦除 zod 类型，由 builder 摊平时注入；ctx 为运行时上下文，P2-11） */
  execute: (
    args: Record<string, unknown>,
    sharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>
}

/**
 * Runtime 配置（每轮可换：brain/sense 由上层原子解析后整体更新）
 * 由 builder 层构建摊平后注入，ctx 运行期不再依赖 SenseManager。
 */
export interface RuntimeConfig {
  /** Brain 服务配置（model/url/key/thinking/provider） */
  brain: BrainConfig
  /** Provider adapter 实例集合（llm/message/sense，随 brain.provider 决定） */
  adapters: AdaptersGroup
  /** 预构建的 API 感官参数（给 LLM 的 function 列表） */
  builtSenses: SenseFunction[]
  /** 感官查找表（name → 监管等级 + 执行器） */
  senseTable: Map<string, SenseEntry>
}

/**
 * Adapter 分组 - provider adapter 实例集合
 */
export interface AdaptersGroup {
  /** LLM Adapter，处理 chat/chatStream 调用 */
  llmAdapter: LLMAdapter
  /** Message Adapter，处理消息格式转换 */
  messageAdapter: MessageProviderAdapterConfig
  /** Sense Adapter，处理感官调用格式转换（随 brain.provider 决定） */
  senseAdapter: SenseAdapter<unknown>
}

/**
 * Agent 运行期消息快照（agent → service 事件载荷）
 */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'sense' | 'role' | 'subagent' // role=新（子 pet 回复）；subagent=旧历史兼容
  content?: string
  thinking?: string
  senseCalls?: Array<{ id: string; name: string; arguments: string }>
  /** 感官执行结果的 hash */
  hash?: string
  /** 已撤回 */
  revoked?: boolean
  contextCompaction?: boolean
  contextCompactionTokens?: number
}

/**
 * 消息更新 patch（区分普通内容更新与感官去重替换）。
 * - content kind：recovery 场景，写回 sense 执行结果 content + hash。
 * - replace kind：感官去重命中，必须携带 content（短说明）+ replace + originalContent，
 *   严禁"有 replace 无 content"——否则 DB 保留旧长内容，与内存/前端/重启回放不一致。
 */
export type AgentMessagePatch =
  | {
      kind?: 'content'
      content?: string
      thinking?: string
      senseCalls?: Array<{ id: string; name: string; arguments: string }>
      hash?: string
    }
  | {
      kind: 'replace'
      content: string
      replace: ReplaceInfo
      originalContent: string
      hash?: string
    }

/**
 * 中间件上下文 - 简化结构
 */
export interface MiddlewareContext {
  /** 灵魂分组：聊天标识和上下文关联 */
  soul: SoulGroup
  /** 请求分组：本次请求的输入和模式 */
  global: GlobalConfig
  /** Runtime 配置（每轮可换：brain/sense 变更时更新；constructor 未配置为 undefined，send 前 configureRuntime 注入 + requireRuntime 校验） */
  runtime?: RuntimeConfig
  /**
   * 当前作用域 Logger 句柄（= 全局 logger，读 ALS 取 scope）。
   * 中间件内推荐用 ctx.log.event(...) 以利 IDE 发现；util/sense 可用裸 logger。
   */
  log: Logger
  /**
   * 消息周期日志：集中 ctx.soul.messages 的所有写操作（append/complete/replace/revoke）。
   * 中间件严禁直接 push/in-place 改 ctx.soul.messages，必须经 ctx.journal.* 以保证单一写者不变式。
   * 由 AgentSession 构造时注入（与 soul 同源引用）。
   */
  journal: MessageJournal
}

/**
 * 流式增量
 */
export interface StreamChunk {
  type: 'stream'
  /** 思考增量 */
  thinkingDelta: string
  /** 响应增量 */
  contentDelta: string
  /** Sense call 增量（可选，流式过程中实时传递，index 定位，arguments 为片段） */
  senseDelta?: SenseCallData[]
}

/**
 * 感官触发（待消费）
 * id 使用 AI 响应的 sense_call.id，AI 没有则自己创建
 */
export interface SenseTriggerChunk {
  type: 'sense_end'
  /** AI 响应的 sense_call.id */
  id: string
  /** 感官名称 */
  name: string
  /** 感官参数 JSON */
  arguments: string
  /** 监管等级 */
  supervisionLevel: SupervisionLevel
  // P1-11：approvalResolve/approvalReject 移除，审批 Promise 由 core approvalRegistry 管理，
  //        service ApprovalManager 经 resolveApproval/rejectApproval 触发（去 chunk 函数指针，解耦 core↔service）。
}

/**
 * 感官执行成功
 * id 与 sense_end.id 一致
 */
export interface SenseAcceptChunk {
  type: 'sense_accept'
  /** 与 sense_end.id 一致 */
  id: string
  /** 感官名称 */
  name: string
  /** 执行结果 */
  result: string
  /** 结果 hash（用于历史去重） */
  hash?: string
}

/**
 * 感官执行被拒绝
 * id 与 sense_end.id 一致
 */
export interface SenseRejectChunk {
  type: 'sense_reject'
  /** 与 sense_end.id 一致 */
  id: string
  /** 感官名称 */
  name: string
  /** 拒绝原因 */
  reason: string
}

/**
 * 阶段完成（checkpoint 归纳后 yield）
 */
export interface StagedChunk {
  type: 'staged'
  /** 阶段类型 */
  stagedType: 'thinking_end' | 'content_end' | 'sense_end'
  /** 累积的响应内容 */
  content: string
  /** 累积的思考内容 */
  thinking: string
  /** 感官名称（sense_end 时使用） */
  senseName?: string
  /** 感官参数（sense_end 时使用） */
  senseArguments?: string
  /** sense 调用 id（sense_end 时使用，透传至 wire 供前端关联 result） */
  id?: string
}

/**
 * 完成
 */
export interface DoneChunk {
  type: 'done'
}

/**
 * 已消费（用户输入已进入消息循环）
 */
export interface ConsumedChunk {
  type: 'consumed'
  count: number
  messages?: AgentMessage[]
}

/**
 * 内部副作用：创建消息。
 * 由 service observer 统一消费，middleware 不直接触发 DB/approval 副作用。
 */
export interface MessageCreatedChunk {
  type: 'message_created'
  message: AgentMessage
}

/**
 * 内部副作用：更新消息。
 */
export interface MessageUpdatedChunk {
  type: 'message_updated'
  id: string
  patch: AgentMessagePatch
}

/**
 * 内部副作用：注册待审批 sense。
 */
export interface SensePendingChunk {
  type: 'sense_pending'
  approvalId: string
  senseName: string
  arguments: string
  supervisionLevel: SupervisionLevel
}

/**
 * 内部副作用：一个 assistant turn 产生的完整 ask_user_question 批次。
 * checkpoint 在所有 placeholder sense 已写入 journal 后才发出，observer 先持久化领域状态，
 * streamMapper 再映射为单个 question_batch_requested 协议事件。
 */
export interface QuestionBatchPendingChunk {
  type: 'question_batch_pending'
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

/**
 * 错误 chunk（重试失败或超限时传递）
 */
export interface ErrorChunk {
  type: 'error'
  errors: Array<{
    attempt: number
    timestamp: number
    message: string
    /** 友好文案（ClassifiedError 携带）；表层出口优先用此作用户面，tracingId 由出口前置 */
    userMessage?: string
    /** 错误来源（ClassifiedError 携带）；friendlyMessage 主语依据 */
    source?: import('@/utils/error.js').ErrorSource
    stack?: string
    /** 是否可恢复（可重试） */
    recoverable: boolean
    /** 错误分类（P6a：增加 auth 表示凭证失效，不可重试） */
    category: 'auth' | 'network' | 'provider' | 'timeout' | 'validation' | 'unknown'
  }>
}

/**
 * 角色本轮暂停信号（spawn wait=true 子 agent yield turn 时发送）。
 * 子 agent spawn 孙 agent（wait=true）后 yield turn → loop 本轮结束 → yield 此 chunk；
 * observer 收到 → 仅记录日志，不唤醒主，不设 finished；
 * 子 agent 保持活跃，等待孙 agent 完成后 resume 继续运行。
 */
export interface ChildYieldChunk {
  type: 'child_yield'
  /** 子 chat id（= ctx.soul.chatId） */
  childChatId: string
  /** 子 agent 本轮末条 assistant content（可选，暂停时的状态） */
  content: string
}

/**
 * 角色完成信号（wait=true 唤醒链，见 docs/agent-pet.md §5.4）。
 * 子 loop 正常结束时，若 getWaitedParent 命中（本 chat 是被 wait 的子）→ yield 此 chunk；
 * service observer 消费 → wakeParent 注入角色回复 + 推 role_reply 唤主。
 */
export interface ChildDoneChunk {
  type: 'child_done'
  /** 子 chat id（= ctx.soul.chatId） */
  childChatId: string
  /** 子 agent 末条 assistant content（注入主 chat 的回复内容） */
  content: string
}

/**
 * 中间件 chunk 联合类型
 */
export type MiddlewareChunk =
  | StreamChunk
  | SenseTriggerChunk
  | SenseAcceptChunk
  | SenseRejectChunk
  | StagedChunk
  | ConsumedChunk
  | MessageCreatedChunk
  | MessageUpdatedChunk
  | SensePendingChunk
  | QuestionBatchPendingChunk
  | DoneChunk
  | ErrorChunk
  | ChildYieldChunk
  | ChildDoneChunk

/**
 * 中间件处理函数（Generator 支持）
 */
export type MiddlewareHandler<T = MiddlewareChunk> = (
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<T>,
) => AsyncGenerator<T>

/**
 * 循环策略处理函数
 */
export type LoopHandler<T = MiddlewareChunk> = (
  ctx: MiddlewareContext,
  runChain: () => AsyncGenerator<T, void, unknown>,
) => AsyncGenerator<T, void, unknown>
