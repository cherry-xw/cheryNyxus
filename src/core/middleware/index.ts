import { compose } from "./compose";
import type {
  MiddlewareContext,
  RuntimeConfig,
  MiddlewareHandler,
  LoopHandler,
} from "./types";
import type { LLMResponse } from "../message/adapter";
import type { GlobalConfig } from "@/utils/config";

export * from "./types";
export type { MiddlewareHandler, LoopHandler };

/**
 * Middleware 实例 - 无状态链执行器（单 chat 绑定）
 */
export default class Middleware<T = unknown> {
  private middlewareChain: ReturnType<typeof compose<T>>;

  /** 是否初始化过 */
  private inited = false;
  /** 单 chat 的上下文 */
  private ctx: MiddlewareContext;
  /** 是否有活跃会话迭代器（运行中 send 只入队，不启动第二个 generator） */
  private isRunning = false;
  /** 生成器闭包 */
  private generator: () => AsyncGenerator<T, void, unknown>;

  constructor(
    global: GlobalConfig,
    handlers: MiddlewareHandler<T>[],
    loopHandler?: LoopHandler<T>,
  ) {
    this.ctx = {
      soul: {
        chatId: "",
        senseSharedData: new Map(),
        userInputs: [],
        messages: [],
      },
      global,
      // runtime 由 configureRuntime 原子填充，send 前由 requireRuntime 校验完整性
      runtime: {} as RuntimeConfig,
    };
    this.middlewareChain = compose(handlers);

    // 创建 generator
    this.generator = loopHandler
      ? loopHandler.bind(this, this.ctx, () => this.runChain(this.ctx))
      : this.runChain.bind(this, this.ctx);
  }

  /**
   * 初始化中间件（绑定 chatId，接收上层构建好的初始消息）
   */
  init(chatId: string, messages: LLMResponse[]) {
    if (this.inited) return;
    this.inited = true;

    this.ctx.soul.chatId = chatId;
    this.ctx.soul.messages!.push(...messages);

    return chatId;
  }

  /**
   * 原子配置运行时（每轮可换）。
   * brain/adapters/builtSenses/senseTable 必须来自同一次上层解析，避免 provider 与工具定义混用。
   */
  configureRuntime(runtime: RuntimeConfig): void {
    this.ctx.runtime = runtime;
  }

  /**
   * 单次 chain 执行
   */
  private async *runChain(
    ctx: MiddlewareContext,
  ): AsyncGenerator<T, void, unknown> {
    const generator = this.middlewareChain(ctx);
    for await (const chunk of generator) {
      yield chunk;
      // TODO 疑问？这是内部主动结束设计的吗？
      if (isDoneChunk(chunk)) break;
    }
  }

  /**
   * 发送消息并返回 generator。
   * 空闲时入队并启动一次完整 loop；运行中调用只入队，由当前 loop 的下一轮自动消费。
   */
  async *send(input: string): AsyncGenerator<T, void, unknown> {
    this.requireInitialized();
    this.requireRuntime();
    
    if (input.trim()) {
      this.ctx.soul.userInputs.push({
        content: input.trim(),
        time: Date.now(),
      });
    }

    if (this.isRunning) return

    this.isRunning = true;
    const generator = this.generator();
    try {
      yield* generator;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 校验 runtime 完整性（send/resume 前必须 configureRuntime）
   */
  private requireInitialized(): void {
    if (!this.inited || !this.ctx.soul.chatId) {
      throw new Error("Chat not initialized. Call init() before send().");
    }
  }

  private requireRuntime(): void {
    const r = this.ctx.runtime;
    if (!r.brain || !r.adapters || !r.builtSenses || !r.senseTable) {
      throw new Error(
        "Runtime not fully configured. Call configureRuntime() before send().",
      );
    }
  }
}

/**
 * 类型守卫：判断是否为 DoneChunk
 */
function isDoneChunk(chunk: unknown): boolean {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as { type: string }).type === "done"
  );
}
