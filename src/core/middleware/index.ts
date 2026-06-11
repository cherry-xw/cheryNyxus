import { compose } from "./compose";
import type {
  MiddlewareContext,
  AdaptersGroup,
  RuntimeConfig,
  SenseEntry,
  MiddlewareHandler,
  LoopHandler,
  PersistMessageData,
} from "./types";
import type { LLMResponse } from "../message/index";
import type { SenseFunction } from "../sense/adapter";
import type { GlobalConfig, BrainConfig } from "@/utils/config";
import buildFirstSystemPrompt from "../prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export type { MiddlewareHandler, LoopHandler };

/**
 * Middleware 实例 - 无状态链执行器（单 chat 绑定）
 *
 * 解耦后：
 * - 一个实例只服务一个 chat（去除 chatMap 模式）
 * - 构造只接收跨轮不变项（global / handlers / loopHandler）
 * - brain/sense 为运行时参数，通过 setBrain / setSense 注入 ctx.runtime，每轮可换
 * - 实例跨轮不重建，messages 天然保留，无需迁移
 *
 * 泛型参数 T 表示 yield 的 chunk 类型
 */
export default class Middleware<T = unknown> {
  private global: GlobalConfig;
  private middlewareChain: ReturnType<typeof compose<T>>;
  private loopHandler?: LoopHandler<T>;

  /** 单 chat 绑定标识 */
  private chatId?: string;
  /** 单 chat 的上下文 */
  private ctx?: MiddlewareContext;
  /** 活跃会话迭代器（防止并发 send） */
  private activeGenerator?: AsyncGenerator<T, void, unknown>;

  constructor(
    global: GlobalConfig,
    handlers: MiddlewareHandler<T>[],
    loopHandler?: LoopHandler<T>,
  ) {
    this.global = global;
    this.middlewareChain = compose(handlers);
    this.loopHandler = loopHandler;
  }

  /**
   * 创建聊天（绑定 chatId，初始化 soul + system 消息）
   * runtime 占位，待 setBrain / setSense 填充后才能 send。
   */
  createChat(chatId: string): string {
    if (this.chatId) {
      // 已绑定，幂等返回
      return this.chatId;
    }

    this.chatId = chatId;

    const now = Date.now();
    const systemMessage: LLMResponse = {
      id: uuid(),
      role: "system",
      content: buildFirstSystemPrompt(),
      createdAt: now,
      updateAt: now,
    };

    this.ctx = {
      soul: {
        chatId,
        senseSharedData: new Map(),
        userInputs: [],
        messages: [systemMessage],
      },
      global: this.global,
      // runtime 由 setBrain/setSense 填充，send 前由 requireRuntime 校验完整性
      runtime: {} as RuntimeConfig,
    };

    return chatId;
  }

  /**
   * 设置 brain（每轮可换）
   * brain.provider 决定 adapters（llm/message/sense），由 builder 层 resolve 后传入。
   */
  setBrain(brain: BrainConfig, adapters: AdaptersGroup): void {
    const ctx = this.requireCtx();
    ctx.runtime.brain = brain;
    ctx.runtime.adapters = adapters;
  }

  /**
   * 设置 sense（每轮可换）
   * builtSenses（给 LLM）+ senseTable（监管等级 + 执行器）由 builder 层摊平后传入。
   */
  setSense(builtSenses: SenseFunction[], senseTable: Map<string, SenseEntry>): void {
    const ctx = this.requireCtx();
    ctx.runtime.builtSenses = builtSenses;
    ctx.runtime.senseTable = senseTable;
  }

  /**
   * 注入消息持久化回调（middleware 不直接依赖 DB，由 service 层注入）
   */
  onPersist(callback: (message: PersistMessageData) => void): void {
    this.requireCtx().persistMessage = callback;
  }

  /**
   * 注入消息更新回调（pending sense 执行后 UPDATE 已有记录而非 INSERT）
   */
  onUpdate(callback: (id: string, content: string) => void): void {
    this.requireCtx().updateMessage = callback;
  }

  /**
   * 加载历史消息到内存（幂等：historyLoaded 标记防止重复加载）
   * 仅接收已解析的 LLMResponse，DB 读取/parse 由 service 层完成。
   */
  loadHistory(messages: LLMResponse[]): void {
    const ctx = this.requireCtx();
    if (ctx.soul.historyLoaded) return;
    ctx.soul.messages ??= [];
    for (const m of messages) {
      ctx.soul.messages.push(m);
    }
    ctx.soul.historyLoaded = true;
  }

  /**
   * 清理聊天上下文（删除 chat 时调用）
   */
  clearChat(): void {
    this.chatId = undefined;
    this.ctx = undefined;
    this.activeGenerator = undefined;
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
   * 发送消息并返回 generator
   */
  async *send(chatId: string, input: string): AsyncGenerator<T, void, unknown> {
    const ctx = this.requireBoundChat(chatId);
    this.requireRuntime(ctx);

    // 存储用户输入
    if (input.trim()) {
      ctx.soul.userInputs.push({
        content: input.trim(),
        time: Date.now(),
      });
    }

    // 检查是否有正在运行的 generator
    if (this.activeGenerator) {
      throw new Error(`Chat "${chatId}" is already processing a message`);
    }

    // 创建 generator
    const generator = this.loopHandler
      ? this.loopHandler(ctx, () => this.runChain(ctx))
      : this.runChain(ctx);
    this.activeGenerator = generator;

    try {
      yield* generator;
    } finally {
      this.activeGenerator = undefined;
    }
  }

  /**
   * 从中断点恢复执行（不注入 userInputs，直接启动 chain）
   * 用于 history recovery：senseMiddleware Phase 0 自动检测 pending approvals 并重执行
   */
  async *resume(chatId: string): AsyncGenerator<T, void, unknown> {
    const ctx = this.requireBoundChat(chatId);
    this.requireRuntime(ctx);

    if (this.activeGenerator) {
      throw new Error(`Chat "${chatId}" is already processing a message`);
    }

    const generator = this.loopHandler
      ? this.loopHandler(ctx, () => this.runChain(ctx))
      : this.runChain(ctx);
    this.activeGenerator = generator;

    try {
      yield* generator;
    } finally {
      this.activeGenerator = undefined;
    }
  }

  /**
   * 校验 ctx 已创建
   */
  private requireCtx(): MiddlewareContext {
    if (!this.ctx) {
      throw new Error("Chat not created. Call createChat() first.");
    }
    return this.ctx;
  }

  /**
   * 校验 chatId 绑定一致
   */
  private requireBoundChat(chatId: string): MiddlewareContext {
    if (!this.ctx || this.chatId !== chatId) {
      throw new Error(`Chat "${chatId}" not bound to this middleware`);
    }
    return this.ctx;
  }

  /**
   * 校验 runtime 完整性（send/resume 前必须 setBrain + setSense）
   */
  private requireRuntime(ctx: MiddlewareContext): void {
    const r = ctx.runtime;
    if (!r.brain || !r.adapters || !r.builtSenses || !r.senseTable) {
      throw new Error(
        "Runtime not fully configured. Call setBrain() and setSense() before send().",
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
