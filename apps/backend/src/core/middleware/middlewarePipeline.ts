import { compose, type ComposedMiddleware } from './compose'
import type { MiddlewareContext, MiddlewareHandler, LoopHandler } from './types'

/**
 * 中间件链执行器：只负责 compose/run/abort + 运行状态。
 * 不持有 messages/userInputs（归 MessageJournal），不持 runtime（归 AgentSession）。
 * 此前 Middleware 类将链执行与消息状态混在一起（问题10），拆分后职责单一。
 */
export class MiddlewarePipeline<T = unknown> {
  private readonly chain: ComposedMiddleware<T>
  private readonly generator: () => AsyncGenerator<T, void, unknown>
  private isRunningFlag = false
  /**
   * 安全暂停请求：断连宽限期到期时由 `requestParkAfterTurn()` 置位。
   * loop 在 runChain 正常结束、下一轮决策前读此标记；命中则抛 `AgentParkError`。
   * 多次设置同值为幂等；abort / send 时清空。
   */
  private parkAfterTurnRequested = false
  /**
   * 与 compose.throw 独立的持久取消态。
   *
   * async generator 的 throw 在 yield* / 外部 await 期间不能作为唯一的终止保证；
   * watchdog abort 后必须让 loop 和 provider 都能观察到该状态，杜绝旧 run 继续下一轮。
   */
  private abortRequested = false
  private abortController: AbortController | null = null

  constructor(
    handlers: MiddlewareHandler<T>[],
    loopHandler: LoopHandler<T> | undefined,
    ctx: MiddlewareContext,
  ) {
    this.chain = compose(handlers)
    // generator 闭包绑定 ctx：loopHandler 传入则用它驱动 loop，否则直接跑 chain
    this.generator = loopHandler
      ? loopHandler.bind(null, ctx, () => this.runChain(ctx))
      : this.runChain.bind(this, ctx)
  }

  /**
   * 启动一次 chain 执行。
   * 空闲时启动并迭代 generator；运行中调用直接返回（send 已入队，由当前 loop 下一轮消费）。
   */
  async *run(): AsyncGenerator<T, void, unknown> {
    if (this.isRunningFlag) return
    this.isRunningFlag = true
    this.abortRequested = false
    this.abortController = new AbortController()
    try {
      yield* this.generator()
    } finally {
      this.isRunningFlag = false
      this.abortController = null
    }
  }

  /**
   * 中止当前运行的 generator。
   * 转发 compose.abort：.throw 注入错误到挂起的 await → senseMiddleware catch → throw 传播退出整个链。
   */
  abort(): void {
    this.parkAfterTurnRequested = false
    this.abortRequested = true
    this.abortController?.abort()
    this.chain.abort()
  }

  /** loop/retry 使用：取消一经请求，在本 run 结束前保持为 true。 */
  isAbortRequested(): boolean {
    return this.abortRequested
  }

  /** provider 使用：当前 run 的请求信号；idle 时不存在。 */
  getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal
  }

  /**
   * 标记当前 generator 在下一轮 loop 决策前抛 `AgentParkError`。
   * 不打断当前 runChain；loop 在 runChain 正常结束后检查该标记并抛 park。
   * 一次 runChain 期间多次请求幂等（同次 set true 重复）。自然停止循环（`stopped=true`）
   * 不再读此标记；新 `send/resume` 会清空。
   */
  requestParkAfterTurn(): void {
    this.parkAfterTurnRequested = true
  }

  /**
   * 当前是否被标记「本轮输出结束后安全暂停」。loop 在每轮 runChain 完成后读取。
   * 读取后由 loop 显式清空（避免连续轮重复抛 park）。
   */
  consumeParkAfterTurn(): boolean {
    if (!this.parkAfterTurnRequested) return false
    this.parkAfterTurnRequested = false
    return true
  }

  /** 是否有活跃会话迭代器（service 层判断 send 恢复撤回仅在 idle 时触发）。 */
  isRunning(): boolean {
    return this.isRunningFlag
  }

  private async *runChain(ctx: MiddlewareContext): AsyncGenerator<T, void, unknown> {
    const generator = this.chain.run(ctx)
    for await (const chunk of generator) {
      yield chunk
    }
  }
}
