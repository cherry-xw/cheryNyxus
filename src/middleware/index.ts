import { compose } from "./compose";
import { messageMiddleware } from "./handler/message";
import { toolMiddleware } from "./handler/tool";
import { chunkMiddleware } from "./handler/chunk";
import { chatMiddleware } from "./handler/chat";
import { createHistoryProxy } from "./utils";

import type { GlobalConfig, ClientConfig } from "@/config";
import { ToolManager } from "@/tool/index";
import {
  type MiddlewareChunk,
  type MiddlewareContext,
  type AdaptersGroup,
  type InterruptChunk,
} from "./types";
import buildPrompt from "@/prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export { compose };
export { messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware };

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
    },
    tools: {
      toolManager,
    },
  };
}

/**
 * Middleware 实例 - 封装请求处理逻辑
 */
export default class Middleware {
  middlewareChain: ReturnType<typeof compose>;
  thread = new Map<string, MiddlewareContext>();
  constructor(
    private sessionId: string,
    private global: GlobalConfig,
    private config: ClientConfig,
    private tool: ToolManager,
    private adapters: AdaptersGroup,
  ) {
    this.middlewareChain = compose([
      messageMiddleware,
      toolMiddleware,
      chunkMiddleware,
      chatMiddleware,
    ]);
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
   * 队列状态（每 threadId 独立，存储用户消息队列）
   */
  private queueStates = new Map<string, {
    queue: Array<{ input: string; resolve: (value: MiddlewareChunk) => void; reject: (err: unknown) => void }>;
    processing: boolean;
    aborted: boolean;
  }>();

  private getQueueState(threadId: string) {
    let state = this.queueStates.get(threadId);
    if (!state) {
      state = { queue: [], processing: false, aborted: false };
      this.queueStates.set(threadId, state);
    }
    return state;
  }

  /**
   * 发送消息（loop 执行模式）
   */
  async *send(
    threadId: string,
    input: string,
  ): AsyncGenerator<MiddlewareChunk> {
    const ctx = this.thread.get(threadId);
    if (!ctx) {
      throw new Error("Thread not found");
    }

    const state = this.getQueueState(threadId);

    // 等待前一个 invocation 完成
    while (state.processing) {
      await new Promise<void>((resolve) => {
        state.queue.push({ input: "", resolve: () => resolve(), reject: () => resolve() });
      });
    }

    state.processing = true;

    // 累积用户消息
    if (input.trim()) {
      const now = Date.now();
      ctx.process.history.push({
        id: uuid(),
        role: "user",
        content: input,
        createdAt: now,
        updateAt: now,
        raw: {},
      });
    }

    try {
      // loop 执行机制
      while (!state.aborted) {
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
    } finally {
      state.aborted = false;
      state.processing = false;
      // 处理队列中等待的下一个请求
      while (state.queue.length > 0) {
        const next = state.queue.shift()!;
        next.resolve({ type: "done" } as MiddlewareChunk);
      }
    }
  }
}
