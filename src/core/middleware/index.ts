import { compose } from "./compose";
import type { MiddlewareContext, AdaptersGroup, MiddlewareHandler, LoopHandler } from "./types";
import type { LLMResponse } from "../message/index";
import type { ToolManager, ToolFunction } from "../tool/index";
import type { GlobalConfig, AIServerConfig } from "@/utils/config";
import buildFirstSystemPrompt from "../prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export type { MiddlewareHandler, LoopHandler };

/**
 * Middleware 实例 - 封装请求处理逻辑
 * 职责：链执行、loopHandler 委托、线程生命周期管理
 * 泛型参数 T 表示 yield 的 chunk 类型
 */
export default class Middleware<T = unknown> {
  /** 线程上下文映射 */
  readonly threadMap = new Map<string, MiddlewareContext>();
  /** 活跃的会话迭代器 */
  private activeGenerators = new Map<string, AsyncGenerator<T, void, unknown>>();
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
    // 初始化配置
    this.sessionId = sessionId;
    this.global = global;
    this.aiServerConfig = aiServerConfig;
    this.toolManager = toolManager;
    this.adapters = adapters;
    this.builtTools = builtTools ?? [];

    this.middlewareChain = compose(handlers);
    this.loopHandler = loopHandler;
  }

  // 配置属性（从构造函数注入）
  private sessionId: string;
  private global: GlobalConfig;
  private aiServerConfig: AIServerConfig;
  private toolManager: ToolManager;
  private adapters: AdaptersGroup;
  private builtTools: ToolFunction[];

  /**
   * 创建新一轮会话
   */
  createThread(threadId: string): string {
    if (this.threadMap.has(threadId)) {
      return threadId;
    }

    const now = Date.now();
    const systemMessage: LLMResponse = {
      id: uuid(),
      role: "system",
      content: buildFirstSystemPrompt(),
      createdAt: now,
      updateAt: now,
    };

    const ctx: MiddlewareContext = {
      session: {
        sessionId: this.sessionId,
        threadId,
        hashCheck: new Map(),
        toolSharedData: new Map(),
        userInputs: [],
        builtTools: this.builtTools,
        messages: [systemMessage],
      },
      global: this.global,
      aiServer: this.aiServerConfig,
      adapters: this.adapters,
      toolManager: this.toolManager,
    };

    this.threadMap.set(threadId, ctx);
    return threadId;
  }

  /**
   * 获取线程上下文
   */
  getContext(threadId: string): MiddlewareContext | undefined {
    return this.threadMap.get(threadId);
  }

  /**
   * 单次 chain 执行
   */
  private async *runChain(ctx: MiddlewareContext): AsyncGenerator<T, void, unknown> {
    const generator = this.middlewareChain(ctx);
    for await (const chunk of generator) {
      yield chunk;
      if (isDoneChunk(chunk)) break;
    }
  }

  /**
   * 发送消息并返回 generator
   */
  async *send(threadId: string, input: string): AsyncGenerator<T, void, unknown> {
    const ctx = this.getContext(threadId);
    if (!ctx) throw new Error("Thread not found");

    // 存储用户输入
    if (input.trim()) {
      ctx.session.userInputs.push({
        content: input.trim(),
        time: Date.now(),
      });
    }

    // 检查是否有正在运行的 generator
    const existing = this.activeGenerators.get(threadId);
    if (existing) {
      yield* existing;
      return;
    }

    // 创建 generator
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