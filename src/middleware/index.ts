import { compose } from "./compose";
import { messageMiddleware } from "./handler/message";
import { toolMiddleware, continueToolExecution } from "./handler/tool";
import { chunkMiddleware } from "./handler/chunk";
import { chatMiddleware } from "./handler/chat";

import type { GlobalConfig, ClientConfig } from "@/config";
import { ToolManager } from "@/tool/index";
import {
  RetryState,
  type MiddlewareChunk,
  type MiddlewareContext,
  type AdaptersGroup,
  type MessageStreamChunk,
} from "./types";
import buildPrompt from "@/prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export { compose };
export { messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware };
export { continueToolExecution };
export { RetryState } from "./types";

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
      accumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
    },
    tools: {
      toolManager,
      toolCallAccumulated: new Map(),
    },
    response: {
      raw: undefined,
      finalContent: "",
      finalThinking: undefined,
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
   * 确认执行待定的 tool 调用
   * @param threadId 会话线程ID（从 MessageStreamChunk.threadId 获取）
   * @param approved 用户是否批准执行
   * @param interruptInfo 中断信息（从 MessageStreamChunk.pendingTool 获取）
   */
  async confirmToolCall(
    threadId: string,
    approved: boolean,
    interruptInfo: {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    },
  ): Promise<MessageStreamChunk> {
    // 恢复原thread的context
    const ctx = this.thread.get(threadId);
    if (!ctx) {
      throw new Error("Thread not found");
    }

    // 验证interrupt状态
    if (!ctx.state.needInterrupt || !ctx.state.interruptInfo) {
      throw new Error("No pending interrupt in this thread");
    }

    // 验证传入的interruptInfo与当前状态匹配
    const currentInfo = ctx.state.interruptInfo;
    if (
      currentInfo.toolCallId !== interruptInfo.toolCallId ||
      currentInfo.toolName !== interruptInfo.toolName
    ) {
      throw new Error("Interrupt info mismatch");
    }

    // 执行工具调用（用户确认或拒绝）
    for await (const _ of continueToolExecution(ctx, approved)) {
      // 遍历 Generator 执行完毕
    }

    // 如果设置了回退状态，重新执行中间件链获取新响应
    if (ctx.state.retryState === RetryState.retryMessage) {
      ctx.state.retryState = RetryState.none;

      const chunks: MiddlewareChunk[] = [];
      let interrupted = false;
      let newInterrupt: any;

      const generator = this.middlewareChain(ctx);
      for await (const chunk of generator) {
        chunks.push(chunk);
        if (chunk.type === "interrupt") {
          interrupted = true;
          newInterrupt = {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: chunk.args,
          };
          break;
        }
      }

      if (interrupted && newInterrupt) {
        return {
          status: "pending",
          thinkingDelta: "",
          delta: "",
          accumulated: "",
          pendingTool: newInterrupt,
          raw: undefined,
        };
      }

      const doneChunk = chunks.find((c) => c.type === "staged");
      if (doneChunk && doneChunk.type === "staged") {
        return {
          status: "success",
          thinkingDelta: "",
          thinkingAccumulated: doneChunk.thinking,
          delta: "",
          accumulated: doneChunk.content,
          raw: doneChunk.raw,
        };
      }
    }

    return {
      status: "success",
      thinkingDelta: "",
      thinkingAccumulated: ctx.response.finalThinking,
      delta: "",
      accumulated: ctx.response.finalContent,
      raw: ctx.response.raw,
    };
  }

  /**
   * 发送消息（两阶段执行）
   */
  private async send(
    ctx: MiddlewareContext,
    input: string,
  ): Promise<MessageStreamChunk[]> {
    const now = Date.now();
    ctx.process.history.push({
      id: uuid(),
      role: "user",
      content: input,
      createdAt: now,
      updateAt: now,
      raw: undefined,
    });
    const generator = this.middlewareChain(ctx);
    const chunks: MiddlewareChunk[] = [];
    let interrupted = false;
    let interruptInfo: any;
    for await (const chunk of generator) {
      chunks.push(chunk);
      if (chunk.type === "interrupt") {
        interrupted = true;
        interruptInfo = {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: chunk.args,
          threadId: ctx.session.threadId,
        };
        break;
      }
    }

    if (interrupted && interruptInfo) {
      return [
        {
          status: "pending",
          thinkingDelta: "",
          delta: "",
          accumulated: "",
          pendingTool: interruptInfo,
          raw: undefined,
        },
      ];
    }

    // 查找最后一次的 staged chunk（retry 后可能存在多个）
    const stagedChunks = chunks.filter((c) => c.type === "staged");
    return stagedChunks.map((el) => ({
      status: "success",
      thinkingDelta: "",
      thinkingAccumulated: el.thinking,
      delta: "",
      accumulated: el.content,
      raw: el.raw,
    }));
  }

  /**
   * 发送消息（流式）
   */
  private async *sendStream(
    ctx: MiddlewareContext,
    input: string,
  ): AsyncGenerator<MessageStreamChunk> {
    const now = Date.now();
    ctx.process.history.push({
      id: uuid(),
      role: "user",
      content: input,
      createdAt: now,
      updateAt: now,
      raw: {},
    });

    const generator = this.middlewareChain(ctx);
    for await (const chunk of generator) {
      if (chunk.type === "stream") {
        yield {
          thinkingDelta: chunk.thinkingDelta,
          thinkingAccumulated: chunk.thinkingAccumulated,
          delta: chunk.delta,
          accumulated: chunk.accumulated,
          status: "success",
          raw: chunk.raw,
        };
      } else if (chunk.type === "interrupt") {
        // 流式模式下的工具中断（暂不支持两阶段确认）
        // 直接自动执行
        yield {
          thinkingDelta: "",
          thinkingAccumulated: ctx.process.thinkingAccumulated,
          delta: "",
          accumulated: ctx.process.accumulated,
          status: "pending",
          pendingTool: {
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: chunk.args,
          },
          raw: { type: "interrupt", toolName: chunk.toolName },
        };
      } else if (chunk.type === "staged") {
        yield {
          thinkingDelta: "",
          thinkingAccumulated: ctx.process.thinkingAccumulated,
          delta: "",
          accumulated: ctx.process.accumulated,
          status: "success",
          raw: chunk.raw,
        };
      } else if (chunk.type === "done") {
        yield {
          thinkingDelta: "",
          thinkingAccumulated: ctx.process.thinkingAccumulated,
          delta: "",
          accumulated: ctx.process.accumulated,
          status: "success",
          raw: "",
        };
      }
    }
  }

  async *invoke(
    threadId: string,
    input: string,
  ): AsyncGenerator<MessageStreamChunk> {
    const ctx = this.thread.get(threadId);
    if (!ctx) {
      throw new Error("Thread not found");
    }
    if (ctx.global.stream) {
      const generator = this.sendStream(ctx, input);
      for await (const chunk of generator) {
        yield chunk;
      }
    } else {
      // 非流式模式：调用 send 方法，将数组转换为 AsyncGenerator
      const results = await this.send(ctx, input);
      for (const chunk of results) {
        yield chunk;
      }
    }
  }
}
