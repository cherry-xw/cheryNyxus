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
  type MessageStreamChunk,
} from "./types";
import buildPrompt from "@/prompt/index";
import { v4 as uuid } from "uuid";

export * from "./types";
export { compose };
export { messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware };
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
    const ctx = this.validateInterrupt(threadId, interruptInfo);
    const { toolCallId, toolName, args } = ctx.state.interruptInfo!;

    // 清理interrupt状态
    ctx.state.interruptInfo = undefined;
    ctx.state.needInterrupt = false;

    // 累积 assistant 消息
    this.accumulateAssistantMessage(ctx, toolCallId, toolName, args);

    // 执行或拒绝 tool
    await this.executeOrRejectTool(ctx, approved, toolCallId, toolName, args);

    // 清空未执行的 toolCallAccumulated
    this.clearPendingToolCalls(ctx);

    // 重新执行中间件链
    return this.restartChain(ctx);
  }

  /**
   * 验证中断状态
   */
  private validateInterrupt(
    threadId: string,
    interruptInfo: { toolCallId: string; toolName: string; args: Record<string, unknown> },
  ): MiddlewareContext {
    const ctx = this.thread.get(threadId);
    if (!ctx) {
      throw new Error("Thread not found");
    }

    if (!ctx.state.needInterrupt || !ctx.state.interruptInfo) {
      throw new Error("No pending interrupt in this thread");
    }

    const currentInfo = ctx.state.interruptInfo;
    if (
      currentInfo.toolCallId !== interruptInfo.toolCallId ||
      currentInfo.toolName !== interruptInfo.toolName
    ) {
      throw new Error("Interrupt info mismatch");
    }

    return ctx;
  }

  /**
   * 累积 assistant 消息（包含 tool_calls）到 history
   */
  private accumulateAssistantMessage(
    ctx: MiddlewareContext,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    const now = Date.now();
    ctx.process.history.push({
      id: uuid(),
      role: "assistant",
      content: "",
      thinking: "",
      toolCalls: [{ tid: toolCallId, name: toolName, arguments: JSON.stringify(args) }],
      createdAt: now,
      updateAt: now,
      raw: null,
    });
  }

  /**
   * 执行或拒绝 tool，累积结果到 history
   */
  private async executeOrRejectTool(
    ctx: MiddlewareContext,
    approved: boolean,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    const now = Date.now();

    if (!approved) {
      ctx.process.history.push({
        id: uuid(),
        role: "tool",
        content: "用户拒绝执行该操作",
        createdAt: now,
        updateAt: now,
        raw: { toolCallId },
      });
      return;
    }

    try {
      const result = await this.tool.execute(toolName, args);
      ctx.process.history.push({
        id: uuid(),
        role: "tool",
        content: typeof result === "string" ? result : JSON.stringify(result),
        createdAt: now,
        updateAt: now,
        raw: { toolCallId },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      ctx.process.history.push({
        id: uuid(),
        role: "tool",
        content: `Tool execution failed: ${errorMsg}`,
        createdAt: now,
        updateAt: now,
        raw: { toolCallId },
      });
    }
  }

  /**
   * 清空未执行的 toolCallAccumulated
   */
  private clearPendingToolCalls(ctx: MiddlewareContext): void {
    for (const [tid, acc] of ctx.process.toolCallAccumulated) {
      if (!acc.executionResult) {
        ctx.process.toolCallAccumulated.delete(tid);
      }
    }
  }

  /**
   * 重新执行中间件链并返回结果
   */
  private async restartChain(ctx: MiddlewareContext): Promise<MessageStreamChunk> {
    const chunks: MiddlewareChunk[] = [];
    let newInterrupt: { toolCallId: string; toolName: string; args: Record<string, unknown> } | null = null;

    const generator = this.middlewareChain(ctx);
    for await (const chunk of generator) {
      chunks.push(chunk);
      if (chunk.type === "interrupt") {
        newInterrupt = {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: chunk.args,
        };
        break;
      }
    }

    if (newInterrupt) {
      return {
        status: "pending",
        thinkingDelta: "",
        contentDelta: "",
        content: "",
        pendingTool: newInterrupt,
        raw: undefined,
      };
    }

    const stagedChunk = chunks.find((c) => c.type === "staged");
    if (stagedChunk && stagedChunk.type === "staged") {
      return {
        status: "success",
        thinkingDelta: "",
        thinking: stagedChunk.thinking,
        contentDelta: "",
        content: stagedChunk.content,
        raw: stagedChunk.raw,
      };
    }

    return {
      status: "success",
      thinkingDelta: "",
      thinking: "",
      contentDelta: "",
      content: "",
      raw: undefined,
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
          contentDelta: "",
          content: "",
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
      contentDelta: "",
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
    // 空输入（retry 模式）不添加 user 消息
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

    const generator = this.middlewareChain(ctx);
    for await (const chunk of generator) {
      if (chunk.type === "stream") {
        yield {
          thinkingDelta: chunk.thinkingDelta,
          thinking: chunk.thinkingAccumulated,
          contentDelta: chunk.contentDelta,
          content: chunk.contentAccumulated,
          status: "success",
          raw: chunk.raw,
        };
      } else if (chunk.type === "interrupt") {
        // 流式模式下的工具中断（暂不支持两阶段确认）
        // 直接自动执行
        yield {
          thinkingDelta: "",
          thinking: ctx.process.thinkingAccumulated,
          contentDelta: "",
          content: ctx.process.contentAccumulated,
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
          thinking: ctx.process.thinkingAccumulated,
          contentDelta: "",
          content: ctx.process.contentAccumulated,
          status: "success",
          raw: chunk.raw,
        };
      } else if (chunk.type === "done") {
        yield {
          thinkingDelta: "",
          thinking: ctx.process.thinkingAccumulated,
          contentDelta: "",
          content: ctx.process.contentAccumulated,
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
