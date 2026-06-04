import { compose } from "./compose";

import type { MiddlewareContext, AdaptersGroup } from "./types";
import type { LLMResponse } from "../message/index";
import type { MiddlewareHandler, LoopHandler } from "./types";
import type { ToolManager } from "../tool/index";
import type { GlobalConfig, AIServerConfig } from "@/utils/config";
import buildFirstSystemPrompt from "../prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export type { MiddlewareHandler, LoopHandler };

/**
 * Middleware 实例 - 封装请求处理逻辑
 * handlers 由外部传入（实例层提供）
 * 泛型参数 T 表示 yield 的 chunk 类型
 */
export default class Middleware<T = unknown> {
  middlewareChain: ReturnType<typeof compose<T>>;
  threadMap = new Map<string, MiddlewareContext>();
  /** 活跃的会话迭代器 generator（按 threadId 存储） */
  private activeGenerators = new Map<
    string,
    AsyncGenerator<T, void, unknown>
  >();
  private loopHandler?: LoopHandler<T>;

  constructor(
    private sessionId: string,
    private global: GlobalConfig,
    private aiServerConfig: AIServerConfig,
    private tool: ToolManager,
    private adapters: AdaptersGroup,
    handlers: MiddlewareHandler<T>[],
    loopHandler?: LoopHandler<T>,
  ) {
    this.middlewareChain = compose(handlers);
    this.loopHandler = loopHandler;
  }

  /**
   * 创建新一轮会话
   * @param threadId 会话id
   * @returns 会话id
   */
  createThread(threadId: string) {
    if (this.threadMap.has(threadId)) {
      return threadId;
    }
    const history: LLMResponse[] = [];
    this.threadMap.set(threadId, {
      session: {
        sessionId: this.sessionId,
        threadId: threadId,
        hashCheck: new Map(),
        toolSharedData: new Map(),
      },
      global: this.global,
      config: this.aiServerConfig,
      adapters: this.adapters,
      process: {
        history,
        contentAccumulated: "",
        thinkingAccumulated: "",
        chunkCount: 0,
        toolCallAccumulated: new Map(),
        pendingInputs: [],
      },
      tools: {
        toolManager: this.tool,
      },
    });
    // 初始化系统消息
    const now = Date.now();
    history.push({
      id: uuid(),
      role: "system",
      content: buildFirstSystemPrompt(),
      createdAt: now,
      updateAt: now,
      raw: undefined,
    });
    return threadId;
  }

  /**
   * 单次 chain 执行
   * - 注入 pendingInputs 到 history
   * - 重置累积状态
   * - 执行 middleware chain
   */
  private async *runChain(
    ctx: MiddlewareContext,
  ): AsyncGenerator<T, void, unknown> {
    // 注入用户消息
    while (ctx.process.pendingInputs.length > 0) {
      const entry = ctx.process.pendingInputs.shift();
      if (entry) {
        ctx.process.history.push({
          id: uuid(),
          role: "user",
          content: entry.input,
          createdAt: entry.time,
          updateAt: Date.now(),
          raw: {},
        });
      }
    }

    // 重置累积消息
    ctx.process.contentAccumulated = "";
    ctx.process.thinkingAccumulated = "";
    ctx.process.chunkCount = 0;

    // 执行 middleware chain
    const generator = this.middlewareChain(ctx);

    for await (const chunk of generator) {
      yield chunk;
      if (isDoneChunk(chunk)) break;
    }
  }

  /**
   * 发送消息并返回 generator
   * - 将 input 存入 pendingInputs（不立即注入 history）
   * - 如果已有活跃 generator，返回当前 generator
   * - 如果无活跃 generator，创建新 generator 并执行
   */
  async *send(
    threadId: string,
    input: string,
  ): AsyncGenerator<T, void, unknown> {
    const ctx = this.threadMap.get(threadId);
    if (!ctx) {
      throw new Error("Thread not found");
    }

    // 存储待注入的用户消息
    if (input.trim()) {
      ctx.process.pendingInputs.push({
        input: input.trim(),
        time: Date.now(),
      });
    }

    // 检查是否有正在运行的 generator
    const existing = this.activeGenerators.get(threadId);
    if (existing) {
      yield* existing;
      return;
    }

    // 创建 generator：有 loopHandler 则委托，否则单次执行
    const generator = this.loopHandler
      ? this.loopHandler(ctx, () => this.runChain(ctx))
      : this.runChain(ctx);
    this.activeGenerators.set(threadId, generator);

    try {
      yield* generator;
    } finally {
      this.activeGenerators.delete(threadId);
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
