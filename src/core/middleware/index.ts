import { compose } from "./compose";
import { SessionRegistry } from "./registry.js";
import type { MiddlewareContext, AdaptersGroup } from "./types";
import type { MiddlewareHandler, LoopHandler, MiddlewareChunk } from "./types";
import type { ToolManager, ToolFunction } from "../tool/index";
import type { GlobalConfig, AIServerConfig } from "@/utils/config";

export * from "./types";
export type { MiddlewareHandler, LoopHandler };

/**
 * Middleware 实例 - 封装请求处理逻辑
 * 职责：链执行、loopHandler 委托
 * 线程生命周期管理已提取至 SessionRegistry
 * 泛型参数 T 表示 yield 的 chunk 类型
 */
export default class Middleware<T = unknown> {
  private registry: SessionRegistry<T>;
  middlewareChain: ReturnType<typeof compose<T>>;
  private loopHandler?: LoopHandler<T>;

  constructor(
    sessionId: string,
    global: GlobalConfig,
    aiServerConfig: AIServerConfig,
    toolManager: ToolManager,
    adapters: AdaptersGroup,
    handlers: MiddlewareHandler<T>[],
    loopHandler?: LoopHandler<T>,
    builtTools?: ToolFunction[],
  ) {
    this.registry = new SessionRegistry<T>(
      sessionId,
      global,
      aiServerConfig,
      toolManager,
      adapters,
      builtTools ?? [],
    );
    this.middlewareChain = compose(handlers);
    this.loopHandler = loopHandler;
  }

  /**
   * 创建新一轮会话
   * @param threadId 会话id
   * @returns 会话id
   */
  createThread(threadId: string) {
    this.registry.createContext(threadId);
    return threadId;
  }

  /**
   * 单次 chain 执行
   * - 执行 middleware chain
   */
  private async *runChain(
    ctx: MiddlewareContext,
  ): AsyncGenerator<T, void, unknown> {
    // 执行 middleware chain
    const generator = this.middlewareChain(ctx);

    for await (const chunk of generator) {
      yield chunk;
      if (isDoneChunk(chunk)) break;
    }
  }

  /**
   * 发送消息并返回 generator
   * - 将 input 存入 userInputs
   * - 如果已有活跃 generator，返回当前 generator
   * - 如果无活跃 generator，创建新 generator 并执行
   */
  async *send(
    threadId: string,
    input: string,
  ): AsyncGenerator<T, void, unknown> {
    const ctx = this.registry.getContext(threadId);
    if (!ctx) {
      throw new Error("Thread not found");
    }

    // 存储用户输入
    if (input.trim()) {
      ctx.session.userInputs.push({
        content: input.trim(),
        time: Date.now(),
      });
    }

    // 检查是否有正在运行的 generator
    const existing = this.registry.getGenerator(threadId);
    if (existing) {
      yield* existing;
      return;
    }

    // 创建 generator：有 loopHandler 则委托，否则单次执行
    const generator = this.loopHandler
      ? this.loopHandler(ctx, () => this.runChain(ctx))
      : this.runChain(ctx);
    this.registry.setGenerator(threadId, generator);

    try {
      yield* generator;
    } finally {
      this.registry.deleteGenerator(threadId);
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