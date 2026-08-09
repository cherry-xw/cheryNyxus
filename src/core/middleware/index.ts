import { MiddlewarePipeline } from './middlewarePipeline'
import { MessageJournal } from './messageJournal'
import type {
  MiddlewareContext,
  RuntimeConfig,
  MiddlewareHandler,
  LoopHandler,
  SoulGroup,
  UserInputEntry,
} from './types'
import type { LLMResponse } from '../message/adapter'
import type { GlobalConfig } from '@/utils/config'
import { logger } from '@/utils/logger/index.js'
import { getSenseRegistryVersion } from '../sense/senseRegistry.js'

export * from './types'
export type { MiddlewareHandler, LoopHandler }
// 重新导出 MessageJournal / MiddlewarePipeline 供扩展与测试直接使用
export { MessageJournal } from './messageJournal'
export { MiddlewarePipeline } from './middlewarePipeline'

/**
 * AgentSession - 单 chat 的 agent 会话。
 *
 * 组合三件：
 * - MiddlewarePipeline：洋葱链 compose/run/abort + 运行状态
 * - MessageJournal：messages/userInputs/revoke/pending/resume 等消息周期规则
 * - runtime（每轮可换 brain/sense）
 *
 * 此前 Middleware 类混合链执行、消息状态、撤回/resume 推断、runtime，职责过载（问题10+11）。
 * 拆分后 service 层通过 AgentSession 门面调用，角色推断集中到 MessageJournal。
 */
export default class AgentSession<T = unknown> {
  private readonly ctx: MiddlewareContext
  private readonly journal: MessageJournal
  private readonly pipeline: MiddlewarePipeline<T>
  private inited = false
  private runtime?: RuntimeConfig
  /** configureRuntime 时快照的 senseRegistry 版本（send/resume 入口比对，P1-6） */
  private senseTableVersion = 0

  constructor(
    global: GlobalConfig,
    handlers: MiddlewareHandler<T>[],
    loopHandler?: LoopHandler<T>,
  ) {
    const soul: SoulGroup = {
      chatId: '',
      senseSharedData: new Map(),
      userInputs: [],
      messages: [],
    }
    this.journal = new MessageJournal(soul, logger)
    this.ctx = { soul, global, log: logger, journal: this.journal }
    // P2-4：runtime 由 configureRuntime 原子填充，send 前 requireRuntime 校验。
    //       未配置为 undefined（消除原 {} as RuntimeConfig 类型谎言）。
    this.pipeline = new MiddlewarePipeline(handlers, loopHandler, this.ctx)
    // 暴露 pipeline 引用给 loop 读取安全边界标记（断连宽限期到期时抛 AgentParkError）。
    this.ctx.pipeline = this.pipeline
  }

  /**
   * 初始化中间件（绑定 chatId，接收上层构建好的初始消息）。
   */
  init(chatId: string, messages: LLMResponse[]) {
    if (this.inited) return
    this.inited = true

    this.ctx.soul.chatId = chatId
    this.ctx.soul.messages!.push(...messages)

    return chatId
  }

  /**
   * 原子配置运行时（每轮可换）。
   * brain/adapters/builtSenses/senseTable 必须来自同一次上层解析，避免 provider 与工具定义混用。
   */
  configureRuntime(runtime: RuntimeConfig): void {
    this.runtime = runtime
    this.ctx.runtime = runtime
    this.senseTableVersion = getSenseRegistryVersion()
  }

  /**
   * senseTable 是否过期（registry 被 mcp.reload/重编译改动）。
   * send/resume 入口比对，stale 则重建 senseTable（见 runtime.ts ensureChat）。
   */
  isSenseTableStale(): boolean {
    return this.senseTableVersion !== getSenseRegistryVersion()
  }

  /** Queue one command-plane input before starting the run. Returns stable IDs
   * used by chat.input.submit ACK and consumed message persistence. */
  enqueueInput(
    content: string,
    metadata?: Omit<Partial<UserInputEntry>, 'content' | 'time'>,
  ): UserInputEntry | undefined {
    return this.journal.appendUserInput(content, metadata)
  }

  /**
   * 发送消息并返回 generator。
   * 空闲时入队并启动一次完整 loop；运行中调用只入队，由当前 loop 的下一轮自动消费。
   *
   * @param input 主 user prompt（落库前的最后一条 user message）
   * @param options.extraUserMessages 可选，命令正文（来自 .chery/command/<name>.md 正文）
   *   作为独立 user message 入队，顺序为 extra[0] → extra[1] → ... → 主 input；
   *   LLM 看到「先命令正文、再用户实际消息」按序消费。compact token 自动触发时 compact 正文会
   *   被调用方 unshift 到此数组顶部。详见 docs/agent/command.md。
   */
  async *send(
    input: string,
    options?: {
      extraUserMessages?: string[]
      inputMeta?: Omit<Partial<UserInputEntry>, 'content' | 'time'>
      inputAlreadyQueued?: boolean
    },
  ): AsyncGenerator<T, void, unknown> {
    this.requireInitialized()
    this.requireRuntime()

    const compactRequested = /\[\[command:\/compact\]\]/.test(input)
    // 命令正文入队顺序：extra[0] 先入队 → 主 input 最后入队 → LLM 按 FIFO 消费
    const extras = options?.extraUserMessages
    if (extras && extras.length > 0) {
      for (const extra of extras) {
        this.journal.appendUserInput(extra, { ephemeral: true })
      }
    }
    if (!options?.inputAlreadyQueued) this.journal.appendUserInput(input, options?.inputMeta)
    try {
      yield* this.pipeline.run()
      if (compactRequested) this.journal.compactToLatestSummary()
    } finally {
      this.journal.pruneEphemeralMessages()
    }
  }

  /**
   * 暴露内存消息列表（service observer flush 时读取，判断哪些未落库）。
   * abort(return) 时 checkpoint finally 的 effect yield 不被消费，assistant 仅在内存，
   * 需 observer finally 兜底同步到 DB（见 observeAgentChunks）。
   */
  getMessages(): LLMResponse[] {
    return this.journal.getMessages()
  }

  /** Read-only queued user input snapshot for session recovery. */
  getPendingInputs() {
    return this.journal.getPendingInputs()
  }

  /**
   * 注入角色回复消息（子完成唤醒主，见 docs/agent-pet.md §5.4 唤醒策略调度器）。
   * 委托 MessageJournal（守单一写者）。DB 落库由 service wakeParent addMessage。
   * @param options.silent deferred/barrier 暂存注入不置 roleReplyPending
   * @returns 新消息 id
   */
  appendRoleReply(content: string, options?: { silent?: boolean }): string {
    return this.journal.appendRoleReply(content, options).id
  }

  /**
   * 原地更新指定 sense 消息的 content（ask_user_question yield-turn：占位→用户答案）。
   * 委托 MessageJournal.completeSense（已存在则 in-place 更新，否则创建）。
   * DB 答案由 service question batch 事务先行落库。
   * @returns true=原地更新命中（预期路径）；false=消息不存在（创建了新条目，异常情况）
   */
  completeSenseResult(senseId: string, content: string): boolean {
    const mutation = this.journal.completeSense({ id: senseId, content })
    return mutation.type === 'updated'
  }

  /**
   * 撤回末尾整个当前周期 AI 响应（chat.send 恢复场景使用）。
   * 委托 MessageJournal（角色推断集中）。
   */
  revokeTrailingCycle(): string[] {
    return this.journal.revokeTrailingCycle()
  }

  /**
   * 末尾连续 sense 群中是否存在 pending（空 content）。
   * chat.resume 据此判断 Case1（有 pending → 续接执行）vs Case2（全 done → 进 loop）。
   */
  hasPendingTrailingSense(): boolean {
    return this.journal.hasPendingTrailingSense()
  }

  /** 设置续接标志（chat.resume Case1：首轮 senseMiddleware skip chat 层）。 */
  setResumePending(value: boolean): void {
    this.journal.setResumePending(value)
  }

  /** 是否有活跃会话迭代器（service 层判断 send 恢复撤回仅在 idle 时触发）。 */
  isRunning(): boolean {
    return this.pipeline.isRunning()
  }

  /**
   * 中止当前运行的 generator（chat.abort 等场景）。
   * 委托 MiddlewarePipeline.abort：.throw 注入错误到挂起的 await → senseMiddleware catch →
   * throw 传播退出整个链（不继续 next）。pending sense 在 DB 保持 NULL，
   * 下次 chat.get canResume=true 重新审核。
   */
  abort(): void {
    this.pipeline.abort()
  }

  /**
   * 标记当前运行的 generator 在“下一轮决策前”抛 `AgentParkError`。
   * 用于断连宽限期到期的安全边界（见 docs/service/websocket.md「断连宽限」）：
   * 不立即中断 provider stream，等当前 `runChain()` 输出结束后由 loop 在
   * 下一轮决策前抛 park；observer 归 paused、不写 finished、不唤父。
   * 若 loop 已在自然停止分支（`stopped=true`）则不必再 park，下次 `send/resume`
   * 即可被新 grace 覆盖；同 chat 多次安全边界请求由后到的请求覆盖。
   */
  requestParkAfterTurn(): void {
    this.pipeline.requestParkAfterTurn()
  }

  /**
   * 校验 runtime 完整性（send/resume 前必须 configureRuntime）
   */
  private requireInitialized(): void {
    if (!this.inited || !this.ctx.soul.chatId) {
      throw new Error('Chat not initialized. Call init() before send().')
    }
  }

  private requireRuntime(): void {
    const r = this.runtime
    if (!r || !r.brain || !r.adapters || !r.builtSenses || !r.senseTable) {
      throw new Error('Runtime not fully configured. Call configureRuntime() before send().')
    }
  }
}
