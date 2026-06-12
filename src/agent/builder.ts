import Middleware, {
  defaultHandlers,
  createLoopHandler,
  type MiddlewareChunk,
} from "./middleware/index";
import type { LLMResponse } from "@/core/message/adapter";
import config from "@/utils/config";
import buildFirstSystemPrompt from "@/agent/prompt/index";
import { randomUUID } from "crypto";
import { RuntimeResolver, type RuntimeSelection } from "./runtimeResolver.js";

/**
 * AgentBuilder - RuntimeConfig 工厂 + Middleware 工厂
 *
 * 解耦后职责：
 * - 创建单 chat Middleware 实例
 * - 原子解析 brain + senseGroups 为 RuntimeConfig
 * - 通过 Middleware.configureRuntime 一次性注入运行时
 */
export class AgentBuilder {
  /** 构建的 Middleware 实例（build 后持有，门面方法转发） */
  private agent?: Middleware<MiddlewareChunk>;
  private readonly runtimeResolver = new RuntimeResolver();

  /**
   * 创建空 Middleware 实例（service 层每 chat 一个，跨轮不重建）
   * 构造只注入跨轮不变项：global + handlers + loopHandler
   */
  build(): this {
    this.agent = new Middleware<MiddlewareChunk>(
      config.global,
      defaultHandlers,
      createLoopHandler(config.global.maxLoopCount),
    );
    return this;
  }

  /**
   * 原子配置 brain + senseGroups，避免 provider 与工具定义处于半配置状态。
   */
  configureRuntime(selection: RuntimeSelection): this {
    const runtime = this.runtimeResolver.resolve(selection);
    this.requireAgent().configureRuntime(runtime);
    return this;
  }

  /**
   * 门面：初始化 chat（绑定 chatId，注入历史或 system 消息）
   */
  init(chatId: string, messages?: LLMResponse[]): this {
    this.requireAgent().init(
      chatId,
      messages && messages.length > 0 ? messages : this.createInitialMessages(),
    );
    return this;
  }

  private createInitialMessages(): LLMResponse[] {
    const now = Date.now();
    return [
      {
        id: randomUUID(),
        role: "system",
        content: buildFirstSystemPrompt(),
        createdAt: now,
        updateAt: now,
      },
    ];
  }

  /**
   * 门面：发送消息，返回 chunk generator（透传 Middleware.send）
   */
  run(input: string): AsyncGenerator<MiddlewareChunk, void, unknown> {
    return this.requireAgent().send(input);
  }

  /**
   * 校验 agent 已构建（build 后才可配置/执行）
   */
  private requireAgent(): Middleware<MiddlewareChunk> {
    if (!this.agent) {
      throw new Error("Agent 未构建，需先调用 build()");
    }
    return this.agent;
  }
}
