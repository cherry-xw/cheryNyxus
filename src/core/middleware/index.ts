import { compose } from "./compose";
import type { MiddlewareContext, AdaptersGroup, MiddlewareHandler, LoopHandler } from "./types";
import type { LLMResponse } from "../message/index";
import type { SenseManager, SenseFunction } from "../sense/index";
import type { GlobalConfig, BrainConfig } from "@/utils/config";
import buildFirstSystemPrompt from "../prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export type { MiddlewareHandler, LoopHandler };

/**
 * Middleware 实例 - 封装请求处理逻辑
 * 职责：链执行、loopHandler 委托、聊天生命周期管理
 * 泛型参数 T 表示 yield 的 chunk 类型
 */
export default class Middleware<T = unknown> {
  /** 聊天上下文映射 */
  readonly chatMap = new Map<string, MiddlewareContext>();
  /** 活跃的会话迭代器 */
  private activeGenerators = new Map<string, AsyncGenerator<T, void, unknown>>();
  middlewareChain: ReturnType<typeof compose<T>>;
  private loopHandler?: LoopHandler<T>;

  constructor(
    soulId: string,
    global: GlobalConfig,
    brainConfig: BrainConfig,
    senseManager: SenseManager,
    adapters: AdaptersGroup,
    handlers: MiddlewareHandler<T>[],
    loopHandler?: LoopHandler<T>,
    builtSenses?: SenseFunction[],
  ) {
    // 初始化配置
    this.soulId = soulId;
    this.global = global;
    this.brainConfig = brainConfig;
    this.senseManager = senseManager;
    this.adapters = adapters;
    this.builtSenses = builtSenses ?? [];

    this.middlewareChain = compose(handlers);
    this.loopHandler = loopHandler;
  }

  // 配置属性（从构造函数注入）
  private soulId: string;
  private global: GlobalConfig;
  private brainConfig: BrainConfig;
  private senseManager: SenseManager;
  private adapters: AdaptersGroup;
  private builtSenses: SenseFunction[];

  /**
   * 创建新一轮聊天
   */
  createChat(chatId: string): string {
    if (this.chatMap.has(chatId)) {
      return chatId;
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
      soul: {
        soulId: this.soulId,
        chatId,
        hashCheck: new Map(),
        senseSharedData: new Map(),
        userInputs: [],
        builtSenses: this.builtSenses,
        messages: [systemMessage],
      },
      global: this.global,
      brain: this.brainConfig,
      adapters: this.adapters,
      senseManager: this.senseManager,
    };

    this.chatMap.set(chatId, ctx);
    return chatId;
  }

  /**
   * 获取聊天上下文
   */
  getContext(chatId: string): MiddlewareContext | undefined {
    return this.chatMap.get(chatId);
  }

  /**
   * 清理聊天上下文（删除 chat 时调用）
   */
  clearChat(chatId: string): void {
    this.chatMap.delete(chatId);
    this.activeGenerators.delete(chatId);
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
  async *send(chatId: string, input: string): AsyncGenerator<T, void, unknown> {
    const ctx = this.getContext(chatId);
    if (!ctx) throw new Error("Chat not found");

    // 存储用户输入
    if (input.trim()) {
      ctx.soul.userInputs.push({
        content: input.trim(),
        time: Date.now(),
      });
    }

    // 检查是否有正在运行的 generator
    const existing = this.activeGenerators.get(chatId);
    if (existing) {
      throw new Error(`Chat "${chatId}" is already processing a message`);
    }

    // 创建 generator
    const generator = this.loopHandler
      ? this.loopHandler(ctx, () => this.runChain(ctx))
      : this.runChain(ctx);
    this.activeGenerators.set(chatId, generator);

    try {
      yield* generator;
    } finally {
      this.activeGenerators.delete(chatId);
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
