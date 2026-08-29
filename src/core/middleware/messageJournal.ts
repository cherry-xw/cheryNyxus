import { randomUUID } from 'crypto'
import type { LLMResponse, ReplaceInfo, ThinkingBlock } from '../message/adapter'
import type { Logger } from '@/utils/logger/types'
import { LogLevel } from '@/utils/logger/types'
import { estimateTokens } from '@/utils/token.js'
import type { AgentMessage, AgentMessagePatch, SoulGroup, UserInputEntry } from './types'

/**
 * 消息变更结果（Journal 写操作的返回，供 checkpoint yield message_created/message_updated effect）。
 * 与 checkpointState.CheckpointMessageMutation 结构一致（created 新增 / updated 原地）。
 */
export type MessageMutation =
  | { type: 'created'; message: AgentMessage }
  | { type: 'updated'; id: string; patch: AgentMessagePatch }

/** P1-3：userInputs 队列容量上限；超限必须显式拒绝，不能静默丢弃已接受输入。 */
const MAX_USER_INPUTS = 16

export class UserInputQueueFullError extends Error {
  readonly code = 'INPUT_QUEUE_FULL'

  constructor() {
    super('输入队列已满，请稍后重试')
    this.name = 'UserInputQueueFullError'
  }
}

/**
 * 从压缩回复中提取 <summary> 块正文（compact.md 约定回复为 <analysis> + <summary> 两块）。
 * 注入 LLM 上下文时仅取 summary 块、丢弃 analysis 中间过程；提取不到（模型未按格式输出）
 * 返回原文 trim（容错）。DB 仍存完整 content，此处仅影响"摘要作为后续上下文"的注入。
 */
export function extractSummaryBlock(content: string): string {
  const match = content.match(/<summary>([\s\S]*?)<\/summary>/i)
  return (match?.[1] ?? content).trim()
}

/**
 * 消息周期日志：集中单 chat 的 message 生命周期规则（单一写者）。
 *
 * 此前 revoke/pending/canResume/userInputs 等角色推断散落于 core/middleware/index.ts、
 * checkpoint.ts、checkpointState.ts、handler.ts，规则分散难维护（问题11）。
 * Journal 持有 soul 引用，集中提供意图方法，调用方不再直接推断尾部消息角色，
 * 也不再直接 push/in-place 改 ctx.soul.messages——所有写操作经 Journal，保证不变式。
 *
 * 写方法：appendUserMessages / appendPendingSense / appendAssistant / completeSense / replaceSense
 * 读方法：getMessages / revokeTrailingCycle / hasPendingTrailingSense
 */
export class MessageJournal {
  constructor(
    private readonly soul: SoulGroup,
    private readonly log: Logger,
  ) {}

  /** Snapshot queued inputs without mutating the queue (session-plane hydration). */
  getPendingInputs(): ReadonlyArray<UserInputEntry> {
    return this.soul.userInputs.map((entry) => ({ ...entry }))
  }

  /** 当前运行结束后移除模型专用临时消息，避免污染后续轮次。 */
  pruneEphemeralMessages(): void {
    if (!this.soul.messages?.some((message) => message.ephemeral)) return
    this.soul.messages = this.soul.messages.filter((message) => !message.ephemeral)
  }

  /** 入队用户输入（背压：超 MAX_USER_INPUTS 显式拒绝）。空串跳过。 */
  appendUserInput(
    content: string,
    metadata?: Omit<Partial<UserInputEntry>, 'content' | 'time'>,
  ): UserInputEntry | undefined {
    const trimmed = content.trim()
    if (!trimmed) return undefined
    if (this.soul.userInputs.length >= MAX_USER_INPUTS) {
      // V2 command inputs carry a commandId and must never be silently lost.
      // Legacy chat.send has historical drop-oldest backpressure semantics;
      // keep that compatibility path until the old command is removed.
      if (!metadata?.commandId) {
        this.soul.userInputs.shift()
        this.log.event(
          'input.dropped',
          { reason: 'max-user-inputs', limit: MAX_USER_INPUTS },
          LogLevel.warn,
        )
      } else {
        this.log.event(
          'input.rejected',
          { reason: 'max-user-inputs', limit: MAX_USER_INPUTS },
          LogLevel.warn,
        )
        throw new UserInputQueueFullError()
      }
    }
    const entry: UserInputEntry = {
      content: trimmed,
      time: Date.now(),
      ...(metadata?.inputId ? { inputId: metadata.inputId } : {}),
      ...(metadata?.messageId ? { messageId: metadata.messageId } : {}),
      ...(metadata?.clientMessageId ? { clientMessageId: metadata.clientMessageId } : {}),
      ...(metadata?.commandId ? { commandId: metadata.commandId } : {}),
      ...(metadata?.role ? { role: metadata.role } : {}),
      ...(metadata?.linkRelation ? { linkRelation: metadata.linkRelation } : {}),
      ...(metadata?.ephemeral ? { ephemeral: true } : {}),
      ...(metadata?.persistedContent !== undefined
        ? { persistedContent: metadata.persistedContent }
        : {}),
    }
    this.soul.userInputs.push(entry)
    return entry
  }

  /**
   * 消费 userInputs → 转 user messages 追加到 soul.messages（checkpoint next() 前调用）。
   * 单一写者：drain + push 集中于此，调用方仅据返回值 yield message_created/consumed effect。
   * @returns { messages: 新增 AgentMessage[], consumedCount }；无输入返回空
   */
  appendUserMessages(): { messages: AgentMessage[]; consumedCount: number } {
    const inputs = this.soul.userInputs
    if (inputs.length === 0) return { messages: [], consumedCount: 0 }
    const messages = this.soul.messages ?? []
    const created: AgentMessage[] = []
    for (const input of inputs) {
      const msgId = input.messageId ?? randomUUID()
      const updateAt = Date.now()
      messages.push({
        id: msgId,
        role: input.role ?? 'user',
        content: input.content,
        createdAt: input.time, // 用户发送时间
        updateAt, // 注入消息列表时间
        ...(input.ephemeral ? { ephemeral: true } : {}),
      })
      created.push({
        id: msgId,
        role: input.role ?? 'user',
        content: input.persistedContent ?? input.content,
        createdAt: input.time,
        updateAt,
        ...(input.inputId ? { inputId: input.inputId } : {}),
        ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
        ...(input.commandId ? { commandId: input.commandId } : {}),
        ...(input.linkRelation ? { linkRelation: input.linkRelation } : {}),
        ...(input.ephemeral ? { ephemeral: true } : {}),
      })
    }
    this.soul.messages = messages
    inputs.length = 0 // drain（避免重复处理）
    return { messages: created, consumedCount: created.length }
  }

  /**
   * 追加 pending sense 消息（smart/manual 模式，sense_end 时调用）。
   * resume 续接时 pending 已存在（同 trigger.id）→ 跳过创建，仅返回 created:false。
   * @returns { created, message } — created=true 时调用方 yield message_created effect
   */
  appendPendingSense(trigger: { id: string; name: string; arguments: string }): {
    created: boolean
    message: AgentMessage
  } {
    const messages = this.soul.messages ?? []
    const exists = messages.some((m) => m.id === trigger.id)
    if (!exists) {
      const senseCalls = [{ id: trigger.id, name: trigger.name, arguments: trigger.arguments }]
      messages.push({
        id: trigger.id,
        role: 'sense' as const,
        content: '',
        senseCalls,
        createdAt: Date.now(),
        updateAt: Date.now(),
      })
      this.soul.messages = messages
      return { created: true, message: { id: trigger.id, role: 'sense', content: '', senseCalls } }
    }
    return { created: false, message: { id: trigger.id, role: 'sense', content: '' } }
  }

  /**
   * 追加 assistant 消息（content/thinking/senseCalls 已完整）。
   * 调用方（CheckpointState）负责 assistantFlushed 守卫与"有无内容"判定——本方法纯追加。
   * @param id 预分配的消息 id（可选）。传入则用之（= staged chunk 携带的 msgId，保证实时累积/落库/回放三路同 id）；
   *           省略则现场生成。这样 DB 落库 id = 预分配 id = chat.get 回放 id。
   * @returns AgentMessage（供 yield message_created effect）
   */
  appendAssistant(
    payload: {
      content: string
      thinking: string
      /** Anthropic 扩展：完整 thinking blocks（含 signature）。落库 + 下轮 buildMessages 原样回传。 */
      thinkingBlocks?: ThinkingBlock[]
      senseCalls: Array<{ id: string; name: string; arguments: string }>
    },
    id?: string,
  ): AgentMessage {
    const messages = this.soul.messages ?? []
    const previousUser = [...messages].reverse().find((message) => message.role === 'user')
    const contextCompaction = /\[\[command:\/compact\]\]/.test(previousUser?.content ?? '')
    const contextCompactionTokens = contextCompaction
      ? Math.max(
          0,
          messages
            .filter((message) => message.role !== 'system' && !message.revoked)
            .reduce(
              (total, message) =>
                total + estimateTokens(message.content) + estimateTokens(message.thinking),
              0,
            ) - estimateTokens(extractSummaryBlock(payload.content)),
        )
      : undefined
    const assistantMsg: LLMResponse = {
      id: id ?? randomUUID(),
      role: 'assistant' as const,
      content: payload.content,
      thinking: payload.thinking,
      ...(payload.thinkingBlocks && payload.thinkingBlocks.length > 0
        ? { thinkingBlocks: payload.thinkingBlocks }
        : {}),
      senseCalls: payload.senseCalls,
      createdAt: Date.now(),
      updateAt: Date.now(),
      ...(contextCompaction ? { contextCompaction: true } : {}),
      ...(contextCompactionTokens !== undefined ? { contextCompactionTokens } : {}),
    }
    messages.push(assistantMsg)
    this.soul.messages = messages
    return {
      id: assistantMsg.id,
      role: 'assistant',
      content: payload.content || undefined,
      thinking: payload.thinking || undefined,
      ...(payload.thinkingBlocks && payload.thinkingBlocks.length > 0
        ? { thinkingBlocks: payload.thinkingBlocks }
        : {}),
      senseCalls: payload.senseCalls,
      ...(contextCompaction ? { contextCompaction: true } : {}),
      ...(contextCompactionTokens !== undefined ? { contextCompactionTokens } : {}),
    }
  }

  /**
   * 原地更新 assistant 消息的 senseCalls（流式多 sense_call reconcile 的内存回写）。
   * findIndex-by-id + in-place 语义同 completeSense；未命中（消息不在 journal）静默忽略。
   * 背景：首个 sense_end flushAssistant 时 senseDeltas 未累积完整，流结束后 reconcile
   * 必须双写——内存 journal 回写 + observer 落库。缺内存回写时 loop 下一轮 buildMessages
   * 组装的 tool_calls 缺 trigger，上游报 "tool result's tool id(...) not found"（400 2013）。
   */
  updateAssistantSenseCalls(
    id: string,
    senseCalls: Array<{ id: string; name: string; arguments: string }>,
  ): void {
    const messages = this.soul.messages ?? []
    const existing = messages.find((message) => message.id === id)
    if (!existing) return
    existing.senseCalls = senseCalls
    existing.updateAt = Date.now()
  }

  /**
   * 保留系统提示词与最后一条 compact 摘要，丢弃本次运行之后模型不应再见到的旧上下文。
   * 完整记录已由 observer 根据 message_created effect 持久化，因此这里只影响后续模型调用。
   */
  compactToLatestSummary(): void {
    const messages = this.soul.messages ?? []
    const summary = [...messages].reverse().find((message) => message.contextCompaction)
    const system = messages.find((message) => message.role === 'system')
    if (!summary || !system) return
    this.soul.messages = [
      system,
      {
        ...summary,
        role: 'system',
        content: `以下是此前对话压缩后的上下文摘要。将其视为后续工作的唯一历史上下文：\n\n${extractSummaryBlock(summary.content ?? '')}`,
      },
    ]
  }

  /**
   * 追加角色消息（子完成注入的回复，见 docs/agent-pet.md §5.4 唤醒策略调度器）。
   * 由 service wakeParent 调（守单一写者）：写 soul.messages（内存），DB 落库由 wakeParent 直接 addMessage
   * （主 observer 未运行，不走 message_created effect 路径）。
   * @param content 回复内容（caller 已格式化，如 `[角色 type] result`）
   * @param options.silent true=deferred/barrier 暂存注入，不置 roleReplyPending（主停等态由 wakeScheduler 决定唤主时机）
   * @returns AgentMessage（供 wakeParent addMessage 落库用 id）
   */
  appendRoleReply(content: string, options?: { silent?: boolean }): AgentMessage {
    const messages = this.soul.messages ?? []
    const msg: LLMResponse = {
      id: randomUUID(),
      role: 'role' as const,
      content,
      createdAt: Date.now(),
      updateAt: Date.now(),
    }
    messages.push(msg)
    this.soul.messages = messages
    // silent（deferred/barrier 暂存）：不置 roleReplyPending，主 loop 不会因此多跑一轮；
    // 主停等态下 roleReplyPending 本就无效（loop 未运行），显式区分仅为语义清晰 + 便于 wakeScheduler 决策。
    if (!options?.silent) {
      this.soul.roleReplyPending = true
    }
    return {
      id: msg.id,
      role: 'role',
      content: content || undefined,
    }
  }

  /**
   * 完成 sense 消息（填 content/hash）。
   * - recovery（消息已存在，resume 续接）：原地更新 content/hash/updateAt，返回 updated mutation。
   * - normal（新 sense）：追加新消息，返回 created mutation。
   * 保留 findIndex-by-id + in-place 语义（resume Case1 依赖）。
   */
  completeSense(result: { id: string; content: string; hash?: string }): MessageMutation {
    const messages = this.soul.messages ?? []
    const existingIdx = messages.findIndex((m) => m.id === result.id)
    if (existingIdx !== -1) {
      const existing = messages[existingIdx]!
      existing.content = result.content
      if (result.hash) existing.hash = result.hash
      existing.updateAt = Date.now()
      return {
        type: 'updated',
        id: result.id,
        patch: { content: result.content, hash: result.hash },
      }
    }
    const senseMsg: LLMResponse = {
      id: result.id,
      role: 'sense',
      content: result.content,
      hash: result.hash,
      createdAt: Date.now(),
      updateAt: Date.now(),
    }
    messages.push(senseMsg)
    this.soul.messages = messages
    return {
      type: 'created',
      message: { id: result.id, role: 'sense', content: result.content, hash: result.hash },
    }
  }

  /**
   * 感官去重替换：hash 命中的旧 sense 消息原地改写为短说明（长内容折叠到 originalContent）。
   * 单一写者：in-place 改 originalContent/content/replace 集中于此。
   * @returns 被替换条目数组（供 yield message_updated replace effect）
   */
  replaceSense(matcher: {
    matchHash: string
    newId: string
  }): Array<{ id: string; content: string; replace: ReplaceInfo; originalContent: string }> {
    const messages = this.soul.messages ?? []
    const replaced: Array<{
      id: string
      content: string
      replace: ReplaceInfo
      originalContent: string
    }> = []
    for (const msg of messages) {
      if (msg.role === 'sense' && msg.hash === matcher.matchHash && !msg.replace?.state) {
        const staleNote = `此条旧读取已被新读取结果取代（新记录 id:${matcher.newId}），长内容已折叠，以新记录为准。`
        const replaceInfo: ReplaceInfo = { state: true, by: matcher.newId, content: staleNote }
        msg.originalContent = msg.content
        msg.content = staleNote
        msg.replace = replaceInfo
        replaced.push({
          id: msg.id,
          content: staleNote,
          replace: replaceInfo,
          originalContent: msg.originalContent,
        })
      }
    }
    return replaced
  }

  getMessages(): LLMResponse[] {
    return this.soul.messages ?? []
  }

  /**
   * 撤回末尾整个当前周期 AI 响应（assistant + sense 群）。
   * 从末尾向前收集连续 role==="sense" 群 + 紧邻其前的带 senseCalls assistant，整体 revoked。
   * OpenAI tool_calls 配对约束要求 assistant 与 tool 结果成对移除。
   * @returns 被撤回的 message id；无未完成周期返回 []
   */
  revokeTrailingCycle(): string[] {
    const messages = this.soul.messages ?? []
    if (messages.length === 0) return []

    let i = messages.length - 1
    while (i >= 0 && messages[i]!.role === 'sense') {
      i--
    }
    const senseStart = i + 1
    // 末尾非 sense 群 → 无未完成周期
    if (senseStart === messages.length) return []
    // 紧邻其前必须是带 senseCalls 的 assistant（整个周期的发起者）
    if (i < 0 || messages[i]!.role !== 'assistant' || !messages[i]!.senseCalls?.length) {
      return []
    }

    const revokedIds: string[] = []
    // 撤回 assistant（think/content/tool_calls）
    messages[i]!.revoked = true
    revokedIds.push(messages[i]!.id)
    // 撤回整个 sense 群（含 done）
    for (let j = senseStart; j < messages.length; j++) {
      messages[j]!.revoked = true
      revokedIds.push(messages[j]!.id)
    }

    return revokedIds
  }

  /**
   * 末尾连续 sense 群中是否存在 pending（空 content）。
   * chat.resume Case1（有 pending → 续接执行）vs Case2（全 done → 进 loop）。
   */
  hasPendingTrailingSense(): boolean {
    const messages = this.soul.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!
      if (m.role !== 'sense') break
      if (!m.content) return true
    }
    return false
  }

  /** 设置续接标志（chat.resume Case1：首轮 senseMiddleware skip chat 层）。 */
  setResumePending(value: boolean): void {
    this.soul.resumePending = value
  }
}
