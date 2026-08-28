import { randomUUID } from 'crypto'
import type {
  AgentMessage,
  AgentMessagePatch,
  MiddlewareContext,
  SenseAcceptChunk,
  SenseRejectChunk,
} from '@/core/middleware/types'
import type { SenseCallData } from '@/core/sense/adapter'
import type { ThinkingBlock, ThinkingBlockDelta } from '@/core/message/adapter'
import { SenseCallAssembler } from './senseCallAssembler.js'
import { ThinkingBlockAssembler } from '@/agent/provider/thinkingBlockAssembler.js'

/**
 * Checkpoint 状态管理
 * 从 checkpointMiddleware 中提取，封装状态累积和消息构建逻辑
 */
export class CheckpointState {
  private thinking = ''
  private content = ''
  private senseDeltas: SenseCallData[] = []
  private senseResults: (SenseAcceptChunk | SenseRejectChunk)[] = []
  /** Anthropic 扩展：thinking blocks 累积器（按 index 累积 text/signature） */
  private thinkingBlockAssembler = new ThinkingBlockAssembler()
  /** 第一次 flush 时记录的 thinkingBlocks（防止 finally flush 时清空后取不到） */
  private thinkingBlocks: ThinkingBlock[] = []
  /** 本轮 assistant 是否已在 sense_end 时 flush（避免 finally 重复 push） */
  private assistantFlushed = false
  /** 第一次 flush 时记录的 assistant id（流结束后 reconcile senseCalls 用） */
  private flushedAssistantId: string | null = null
  /** 预分配的本轮 assistant 消息 id（= 落库 id = chat.get 回放 id）。
   *  staged chunk 携此 msgId 供前端实时累积，与 done.finalMessage / chat.get 三路同 id 去重。 */
  private assistantId = randomUUID()
  /** turn 起始时间戳，staged chunk 携此作为实时项 createdAt（reload 后由 DB 值替换）。 */
  private turnStartedAt = Date.now()
  /** 第一次 flush 时记录的 senseCalls（流结束后比对是否需要补充） */
  private flushedAssistantSenseCalls: Array<{ id: string; name: string; arguments: string }> = []

  /**
   * 摄入 chunk，更新内部状态
   */
  ingest(chunk: {
    type: string
    thinkingDelta?: string
    contentDelta?: string
    senseDelta?: SenseCallData[]
    thinkingBlocksDelta?: ThinkingBlockDelta[]
    id?: string
    name?: string
    arguments?: string
    result?: string
    reason?: string
    hash?: string
  }): void {
    switch (chunk.type) {
      case 'stream':
        this.thinking += chunk.thinkingDelta ?? ''
        if (chunk.thinkingBlocksDelta && chunk.thinkingBlocksDelta.length > 0) {
          for (const op of chunk.thinkingBlocksDelta) this.thinkingBlockAssembler.push(op)
        }
        this.content += chunk.contentDelta ?? ''
        if (chunk.senseDelta) {
          this.senseDeltas.push(...chunk.senseDelta)
        }
        break

      case 'sense_accept':
      case 'sense_reject':
        this.senseResults.push(chunk as SenseAcceptChunk | SenseRejectChunk)
        break
    }
  }

  /** Reset every provider-attempt accumulator and rotate the optimistic turn id. */
  resetAttempt(): string {
    const previousAssistantId = this.assistantId
    this.thinking = ''
    this.content = ''
    this.senseDeltas = []
    this.senseResults = []
    this.thinkingBlockAssembler = new ThinkingBlockAssembler()
    this.thinkingBlocks = []
    this.assistantFlushed = false
    this.flushedAssistantId = null
    this.flushedAssistantSenseCalls = []
    this.assistantId = randomUUID()
    this.turnStartedAt = Date.now()
    return previousAssistantId
  }

  /**
   * 在 sense_end 时增量构建并 push 本轮 assistant（content/thinking/senseCalls 已完整）。
   *
   * 为什么不只在 finally 构建：
   * 1. 顺序：pending sense 在 sense_end push，assistant 若在 finally push 会排在 sense 之后
   *    （[user, sense, assistant]），破坏 LLM 消息顺序（assistant 应在 tool result 前），
   *    导致 revokeTrailingCycle 找不到前置 assistant、resume Case1 判定错误。
   * 2. abort 落库：sense_end 在 for-await 循环内，yield message_created effect 被 observer
   *    正常消费落库。abort 时此路径已执行，assistant 已在 DB（finally 的 yield 在 gen.return
   *    传播下会死锁不执行，不可依赖）。
   *
   * @returns AgentMessage（供 checkpoint yield message_created effect）；本轮无内容或已 flush 返回 null
   */
  flushAssistant(ctx: MiddlewareContext): AgentMessage | null {
    if (this.assistantFlushed) return null
    const mergedSenseCalls = mergeSenseDeltas(this.senseDeltas)
    if (!this.content && !this.thinking && mergedSenseCalls.length === 0) return null

    const senseCalls = mergedSenseCalls
      .filter((sc) => sc.name)
      .map((sc) => ({ id: sc.id, name: sc.name!, arguments: sc.arguments }))
    // 快照思考块（flush 后不再变化，供 reconcile 时引用）
    this.thinkingBlocks = this.thinkingBlockAssembler.toArray()
    const message = ctx.journal.appendAssistant(
      {
        content: this.content,
        thinking: this.thinking,
        thinkingBlocks: this.thinkingBlocks.length > 0 ? this.thinkingBlocks : undefined,
        senseCalls,
      },
      this.assistantId,
    )
    this.assistantFlushed = true
    this.flushedAssistantId = message.id
    this.flushedAssistantSenseCalls = senseCalls
    return message
  }

  /**
   * 流结束后 reconcile last assistant 的 senseCalls 字段。
   *
   * 流式多 sense_call 场景：第一次 sense_end flushAssistant 时 senseDeltas 未累积完整
   * （OpenAI 流式 delta 分散到达，yield trigger 早于 ingest chunk），流结束后需要补充新增 trigger。
   * 比对「flush 时记录的 senseCalls」与「最终 mergeSenseDeltas」，有新增则返回 updated mutation
   * （patch.kind="content" + senseCalls），由 observer 落库。
   *
   * @returns updated mutation（含 senseCalls 增量）或 null（无需补充）
   */
  reconcileAssistantSenseCalls(): CheckpointMessageMutation | null {
    if (!this.assistantFlushed || !this.flushedAssistantId) return null
    const finalSenseCalls = mergeSenseDeltas(this.senseDeltas)
      .filter((sc) => sc.name)
      .map((sc) => ({ id: sc.id, name: sc.name!, arguments: sc.arguments }))
    if (finalSenseCalls.length === this.flushedAssistantSenseCalls.length) return null
    return {
      type: 'updated',
      id: this.flushedAssistantId,
      patch: { senseCalls: finalSenseCalls },
    }
  }

  /**
   * 追加 assistant 响应和 sense 结果到 messages
   * （userInputs 已在 checkpoint.ts next() 调用前处理）
   * @returns 消息变更列表（由 checkpoint 发送事件）
   */
  appendResponseMessages(ctx: MiddlewareContext): CheckpointMessageMutation[] {
    const mergedSenseCalls = mergeSenseDeltas(this.senseDeltas)
    const mutations: CheckpointMessageMutation[] = []

    // assistant 响应（包含 thinking 和 senseCalls）
    // sense_call 流已在 sense_end 时 flush（assistantFlushed=true），此处跳过避免重复 push；
    // 仅纯 content/thinking 流（未触发 sense_end）在此构建。
    if (!this.assistantFlushed && (this.content || this.thinking || mergedSenseCalls.length > 0)) {
      const senseCalls = mergedSenseCalls
        .filter((sc) => sc.name)
        .map((sc) => ({ id: sc.id, name: sc.name!, arguments: sc.arguments }))
      this.thinkingBlocks = this.thinkingBlockAssembler.toArray()
      const message = ctx.journal.appendAssistant(
        {
          content: this.content,
          thinking: this.thinking,
          thinkingBlocks: this.thinkingBlocks.length > 0 ? this.thinkingBlocks : undefined,
          senseCalls,
        },
        this.assistantId,
      )
      // 流式场景（无 sense_end 触发）此路径直接拿到完整 senseCalls，不需要 reconcile
      this.assistantFlushed = true
      this.flushedAssistantId = message.id
      this.flushedAssistantSenseCalls = senseCalls
      mutations.push({ type: 'created', message })
    }

    // sense 结果（独立追加，不受 assistant 消息条件限制）
    // completeSense 内部区分 recovery（原地更新）/ normal（新建），保留 findIndex-by-id + in-place 语义。
    for (const r of this.senseResults) {
      const hash = r.type === 'sense_accept' ? r.hash : undefined
      const content = r.type === 'sense_accept' ? r.result : `被拒绝: ${r.reason}`
      mutations.push(ctx.journal.completeSense({ id: r.id, content, hash }))
    }

    return mutations
  }

  /**
   * 获取累积内容
   */
  getContent(): string {
    return this.content
  }

  /**
   * 获取累积思考
   */
  getThinking(): string {
    return this.thinking
  }

  /** 获取累积的 Anthropic thinking blocks（含 signature）；无则返回 undefined。 */
  getThinkingBlocks(): ThinkingBlock[] | undefined {
    const blocks = this.thinkingBlockAssembler.toArray()
    return blocks.length > 0 ? blocks : undefined
  }

  /** 当前 turn 已落 journal 的 assistant message id；问题批次以此作为稳定 batch id。 */
  getFlushedAssistantId(): string | undefined {
    return this.flushedAssistantId ?? undefined
  }

  /** 预分配的本轮 assistant id（staged chunk 携带，供前端实时累积与 done.finalMessage / chat.get 同 id 去重）。 */
  getAssistantId(): string {
    return this.assistantId
  }

  /** turn 起始时间戳（staged chunk createdAt，reload 后由 DB 值替换）。 */
  getTurnStartedAt(): number {
    return this.turnStartedAt
  }
}

export type CheckpointMessageMutation =
  | {
      type: 'created'
      message: AgentMessage
    }
  | {
      type: 'updated'
      id: string
      patch: AgentMessagePatch
    }

/**
 * 合并 senseDelta（按 index 合并 arguments）
 * OpenAI 流式：首个 delta 带 id/name，后续只有 arguments 片段
 * Ollama 流式：每个 delta 可能是完整 sense_call
 *
 * 委托 SenseCallAssembler（与 tool.ts 流式累积共用），保证落库 senseCalls 与 sense_end 触发语义一致。
 */
function mergeSenseDeltas(deltas: SenseCallData[]): SenseCallData[] {
  const asm = new SenseCallAssembler()
  for (const d of deltas) asm.push(d)
  return asm.toArray()
}
