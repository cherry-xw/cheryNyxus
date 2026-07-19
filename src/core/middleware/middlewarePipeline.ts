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
    try {
      yield* this.generator()
    } finally {
      this.isRunningFlag = false
    }
  }

  /**
   * 中止当前运行的 generator。
   * 转发 compose.abort：.throw 注入错误到挂起的 await → senseMiddleware catch → throw 传播退出整个链。
   */
  abort(): void {
    this.chain.abort()
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
