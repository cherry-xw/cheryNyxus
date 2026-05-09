import { compose } from "./compose";
import { messageMiddleware } from "./handler/message";
import { toolMiddleware } from "./handler/tool";
import { chunkMiddleware } from "./handler/chunk";
import { chatMiddleware } from "./handler/chat";

import type { GlobalConfig, ClientConfig } from "@/config";
import { ToolManager } from "@/tool/index";
import {
  RetryState,
  type MiddlewareChunk,
  type MiddlewareContext,
  type AdaptersGroup,
} from "./types";
import buildPrompt from "@/prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export { compose };
export { messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware };
export { RetryState } from "./types";
export { aggregateChunks } from "./utils";

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
    session: { sessionId, threadId, loadedSkills: new Set() },
    global,
    config,
    adapters,
    process: {
      history: [],
      contentAccumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
      toolCallAccumulated: new Map(),
    },
    tools: {
      toolManager,
    },
    state: {
      needInterrupt: false,
      interruptInfo: undefined,
      retryState: RetryState.none,
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
   * 队列状态（每 threadId 独立）
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
   * 发送消息（队列模式，统一返回 AsyncGenerator）
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
      while (!state.aborted) {
        const generator = this.middlewareChain(ctx);

        for await (const chunk of generator) {
          if (chunk.type === "interrupt") {
            // 注入 continue/abort 闭包
            const ic = chunk as import("./types").InterruptChunk;
            let resumeResolve: (() => void) | null = null;
            const resumePromise = new Promise<void>((resolve) => { resumeResolve = resolve; });

            ic.continue = async (reason?: string) => {
              ctx.state.needInterrupt = false;
              ctx.state.interruptInfo = undefined;
              ctx.state.retryState = RetryState.retryMessage;
              // 累积批准理由到 history
              if (reason?.trim()) {
                const now = Date.now();
                ctx.process.history.push({
                  id: uuid(),
                  role: "tool",
                  content: `用户批准执行: ${reason}`,
                  createdAt: now,
                  updateAt: now,
                  raw: { approved: true },
                });
              }
              resumeResolve?.();
            };

            ic.abort = () => {
              state.aborted = true;
              // 累积拒绝消息到 history
              const now = Date.now();
              ctx.process.history.push({
                id: uuid(),
                role: "tool",
                content: "用户拒绝执行该操作",
                createdAt: now,
                updateAt: now,
                raw: { approved: false },
              });
              resumeResolve?.();
            };

            yield ic;
            await resumePromise;

            if (state.aborted) return;
            // continue 被调用，retryState 已设置，外层 while 会重新执行中间件链
            break;
          }

          yield chunk;
          if (chunk.type === "done") break;
        }

        // 无 interrupt，执行完成
        if (ctx.state.retryState !== RetryState.retryMessage) break;
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
