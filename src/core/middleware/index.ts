import { compose, type ComposedMiddleware } from "./compose";
import type {
  MiddlewareContext,
  RuntimeConfig,
  MiddlewareHandler,
  LoopHandler,
} from "./types";
import type { LLMResponse } from "../message/adapter";
import type { GlobalConfig } from "@/utils/config";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";

/** P1-3：userInputs 队列容量上限，超限丢弃最早（背压，防高频 send 无限堆积拖长 loop 串行消费） */
const MAX_USER_INPUTS = 16;

export * from "./types";
export type { MiddlewareHandler, LoopHandler };

/**
 * Middleware 实例 - 无状态链执行器（单 chat 绑定）
 */
export default class Middleware<T = unknown> {
  private middlewareChain: ComposedMiddleware<T>;

  /** 是否初始化过 */
  private inited = false;
  /** 单 chat 的上下文 */
  private ctx: MiddlewareContext;
  /** 是否有活跃会话迭代器（运行中 send 只入队，不启动第二个 generator） */
  private isRunningFlag = false;
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
      log: logger,
      // P2-4：runtime 由 configureRuntime 原子填充，send 前 requireRuntime 校验。
      //       未配置为 undefined（消除原 {} as RuntimeConfig 类型谎言）。
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
   * 撤回末尾整个当前周期 AI 响应（chat.send 恢复场景使用）。
   * 从末尾向前收集连续 role==="sense" 群 + 紧邻其前的 assistant(senseCalls)，
   * 整体标记 revoked=true（含 done sense，统一撤回整个周期回退到上一周期结束）。
   * OpenAI tool_calls 配对约束要求 assistant 与 tool 结果成对移除。
   * @returns 被撤回的 message id（供 service 层 markMessagesRevoked 持久化）；无未完成周期返回 []
   */
  revokeTrailingCycle(): string[] {
    const messages = this.ctx.soul.messages ?? [];
    if (messages.length === 0) return [];

    let i = messages.length - 1;
    while (i >= 0 && messages[i]!.role === "sense") {
      i--;
    }
    const senseStart = i + 1;
    // 末尾非 sense 群 → 无未完成周期
    if (senseStart === messages.length) return [];
    // 紧邻其前必须是带 senseCalls 的 assistant（整个周期的发起者）
    if (
      i < 0 ||
      messages[i]!.role !== "assistant" ||
      !messages[i]!.senseCalls?.length
    ) {
      return [];
    }

    const revokedIds: string[] = [];
    // 撤回 assistant（think/content/tool_calls）
    messages[i]!.revoked = true;
    revokedIds.push(messages[i]!.id);
    // 撤回整个 sense 群（含 done）
    for (let j = senseStart; j < messages.length; j++) {
      messages[j]!.revoked = true;
      revokedIds.push(messages[j]!.id);
    }

    return revokedIds;
  }

  /**
   * 末尾连续 sense 群中是否存在 pending（空 content）。
   * chat.resume 据此判断 Case1（有 pending → 续接执行）vs Case2（全 done → 进 loop）。
   */
  hasPendingTrailingSense(): boolean {
    const messages = this.ctx.soul.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "sense") break;
      if (!m.content) return true;
    }
    return false;
  }

  /**
   * 设置续接标志（chat.resume Case1：首轮 senseMiddleware skip chat 层）。
   */
  setResumePending(value: boolean): void {
    this.ctx.soul.resumePending = value;
  }

  /**
   * 是否有活跃会话迭代器（service 层判断 send 恢复撤回仅在 idle 时触发）。
   */
  isRunning(): boolean {
    return this.isRunningFlag;
  }

  /**
   * 暴露内存消息列表（service observer flush 时读取，判断哪些未落库）。
   * abort(return) 时 checkpoint finally 的 effect yield 不被消费，assistant 仅在内存，
   * 需 observer finally 兜底同步到 DB（见 observeAgentChunks）。
   */
  getMessages(): LLMResponse[] {
    return this.ctx.soul.messages ?? [];
  }

  /**
   * 中止当前运行的 generator（chat.abort 等场景）。
   * 转发 compose.abort：.throw 注入错误到挂起的 await → senseMiddleware catch →
   * throw 传播退出整个链（不继续 next）。pending sense 在 DB 保持 NULL，
   * 下次 chat.get canResume=true 重新审核。
   */
  abort(): void {
    this.middlewareChain.abort();
  }

  /**
   * 单次 chain 执行
   */
  private async *runChain(
    ctx: MiddlewareContext,
  ): AsyncGenerator<T, void, unknown> {
    const generator = this.middlewareChain.run(ctx);
    for await (const chunk of generator) {
      yield chunk;
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
      // P1-3：背压。userInputs 容量上限，超限丢弃最早，避免运行中高频 send 无限堆积拖长 loop 串行消费。
      if (this.ctx.soul.userInputs.length >= MAX_USER_INPUTS) {
        this.ctx.soul.userInputs.shift();
        logger.event("input.dropped", { reason: "max-user-inputs", limit: MAX_USER_INPUTS }, LogLevel.warn);
      }
      this.ctx.soul.userInputs.push({
        content: input.trim(),
        time: Date.now(),
      });
    }

    if (this.isRunningFlag) return

    this.isRunningFlag = true;
    const generator = this.generator();
    try {
      yield* generator;
    } finally {
      this.isRunningFlag = false;
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
    if (!r || !r.brain || !r.adapters || !r.builtSenses || !r.senseTable) {
      throw new Error(
        "Runtime not fully configured. Call configureRuntime() before send().",
      );
    }
  }
}
