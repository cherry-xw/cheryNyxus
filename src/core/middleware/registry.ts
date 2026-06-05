import type { MiddlewareContext, AdaptersGroup } from "./types";
import type { LLMResponse } from "../message/index";
import type { ToolManager, ToolFunction } from "../tool/index";
import type { GlobalConfig, AIServerConfig } from "@/utils/config";
import buildFirstSystemPrompt from "../prompt/index";
import { v4 as uuid } from "uuid";

/**
 * Session 注册表 - 管理线程上下文和活跃生成器
 * 从 Middleware 类中提取，分离线程生命周期管理职责
 */
export class SessionRegistry<T = unknown> {
  /** 线程上下文映射 */
  readonly threadMap = new Map<string, MiddlewareContext>();
  /** 活跃的会话迭代器 generator（按 threadId 存储） */
  private activeGenerators = new Map<string, AsyncGenerator<T, void, unknown>>();

  constructor(
    private sessionId: string,
    private global: GlobalConfig,
    private aiServerConfig: AIServerConfig,
    private toolManager: ToolManager,
    private adapters: AdaptersGroup,
    private builtTools: ToolFunction[],
  ) {}

  /**
   * 创建新一轮会话
   */
  createContext(threadId: string): MiddlewareContext {
    if (this.threadMap.has(threadId)) {
      return this.threadMap.get(threadId)!;
    }

    // 初始化系统消息
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
        threadId: threadId,
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
    return ctx;
  }

  /**
   * 获取线程上下文
   */
  getContext(threadId: string): MiddlewareContext | undefined {
    return this.threadMap.get(threadId);
  }

  /**
   * 检查线程是否存在
   */
  hasThread(threadId: string): boolean {
    return this.threadMap.has(threadId);
  }

  /**
   * 获取活跃生成器
   */
  getGenerator(threadId: string): AsyncGenerator<T, void, unknown> | undefined {
    return this.activeGenerators.get(threadId);
  }

  /**
   * 设置活跃生成器
   */
  setGenerator(threadId: string, gen: AsyncGenerator<T, void, unknown>): void {
    this.activeGenerators.set(threadId, gen);
  }

  /**
   * 删除活跃生成器
   */
  deleteGenerator(threadId: string): void {
    this.activeGenerators.delete(threadId);
  }
}