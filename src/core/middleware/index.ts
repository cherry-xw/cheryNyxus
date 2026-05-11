import { compose } from "./compose";
import { createHistoryProxy } from "./utils";

import type { MiddlewareChunk, MiddlewareContext, AdaptersGroup } from "./types";
import type { MiddlewareHandler } from "./types";
import type { ToolManager } from "../tool/index";
import type { GlobalConfig, ClientConfig } from "@/config";
import buildPrompt from "../prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export { compose };
export type { MiddlewareHandler };

/**
 * 创建中间件上下文
 */
function createMiddlewareContextBase(
  global: GlobalConfig,
  sessionId: string,
  threadId: string,
  config: ClientConfig,
  adapters: AdaptersGroup,
  toolManager: ToolManager,
): MiddlewareContext {
  return {
    session: { sessionId, threadId, hashCheck: new Map() },
    global,
    config,
    adapters,
    process: {
      history: createHistoryProxy(),
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
      pendingInputs: [],
    },
    tools: {
      toolManager,
    },
  };
}

/**
 * Middleware 实例 - 封装请求处理逻辑
 * handlers 由外部传入（实例层提供）
 */
export default class Middleware {
  middlewareChain: ReturnType<typeof compose>;
  thread = new Map<string, MiddlewareContext>();
  /** 活跃的 generator（按 threadId 存储） */
  private activeGenerators = new Map<string, AsyncGenerator<MiddlewareChunk, void, unknown>>();

  constructor(
    private sessionId: string,
    private global: GlobalConfig,
    private config: ClientConfig,
    private tool: ToolManager,
    private adapters: AdaptersGroup,
    handlers: MiddlewareHandler[],
  ) {
    this.middlewareChain = compose(handlers);
  }

  createThread() {
    const threadId = uuid();
    const ctx = createMiddlewareContextBase(
      this.global,
      this.sessionId,
      threadId,
      this.config,
      this.adapters,
      this.tool,
    );
    this.thread.set(threadId, ctx);
    // 初始化系统消息
    const now = Date.now();
    ctx.process.history.push({
      id: uuid(),
      role: "system",
      content: buildPrompt(),
      createdAt: now,
      updateAt: now,
      raw: undefined,
    });
    return threadId;
  }

  /**
   * 发送消息并返回 generator
   * - 将 input 存入 pendingInputs（不立即注入 history）
   * - 如果已有活跃 generator，返回当前 generator
   * - 如果无活跃 generator，创建新 generator 并执行 loop
   */
  async *send(
    threadId: string,
    input: string,
  ): AsyncGenerator<MiddlewareChunk, void, unknown> {
    const ctx = this.thread.get(threadId);
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

    // 创建新 generator
    const generator = this.executeLoop(ctx);
    this.activeGenerators.set(threadId, generator);

    try {
      yield* generator;
    } finally {
      this.activeGenerators.delete(threadId);
    }
  }

  /**
   * 执行 loop（内部方法）
   * - while(times < maxLoop) 执行 middleware chain
   * - 每次 chain 执行前注入 pendingInputs
   * - 每次 loop 后检查是否需要继续
   */
  private async *executeLoop(
    ctx: MiddlewareContext,
  ): AsyncGenerator<MiddlewareChunk, void, unknown> {
    const maxLoop = this.global.maxLoopCount ?? 30;
    let times = 0;

    while (times < maxLoop) {
      times++;

      // chain 执行前注入 pendingInputs
      while (ctx.process.pendingInputs.length > 0) {
        const entry = ctx.process.pendingInputs.shift();
        if (entry) {
          ctx.process.history.push({
            id: uuid(),
            role: "user",
            content: entry.input,
            createdAt: entry.time,
            updateAt: entry.time,
            raw: {},
          });
        }
      }

      // 重置累积状态
      ctx.process.contentAccumulated = "";
      ctx.process.thinkingAccumulated = "";
      ctx.process.chunkCount = 0;

      const generator = this.middlewareChain(ctx);

      for await (const chunk of generator) {
        yield chunk;
        if (chunk.type === "done") break;
      }

      // 检查 loop 停止条件
      // 1. toolCallAccumulated 有数据 → 有未执行的 tool_calls → 继续 loop
      if (ctx.process.toolCallAccumulated.size > 0) {
        continue;
      }

      // 2. 检查最后一条消息
      const lastMessage = ctx.process.history[ctx.process.history.length - 1];
      if (!lastMessage) break;

      // 2.1 最后一条是 tool → 刚执行完 → 继续 loop
      if (lastMessage.role === "tool") {
        continue;
      }

      // 2.2 最后一条是 assistant
      if (lastMessage.role === "assistant") {
        // 有 toolCalls → 已执行完 → 继续 loop
        if (lastMessage.toolCalls && lastMessage.toolCalls.length > 0) {
          continue;
        }
        // 无 toolCalls → 停止 loop
        break;
      }

      // 其他情况（user/system）→ 停止 loop
      break;
    }

    // loop 结束，yield done
    yield { type: "done" };
  }
}