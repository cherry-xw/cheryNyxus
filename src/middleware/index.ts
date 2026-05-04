import { compose } from "./compose";
import { messageMiddleware } from "./handler/message";
import { toolMiddleware, continueToolExecution } from "./handler/tool";
import { chunkMiddleware } from "./handler/chunk";
import { chatMiddleware } from "./handler/chat";
import type { ClientConfigBase } from "@/llm/types";
import type { MiddlewareContext, LLMStreamChunk, AdaptersGroup } from "./types";
import { ToolManager } from "@/tool/index";
import { RetryState, type MiddlewareChunk } from "./types";

export * from "./types";
export { compose };
export { messageMiddleware, toolMiddleware, chunkMiddleware, chatMiddleware };
export { continueToolExecution };
export { RetryState } from "./types";

/**
 * Send方法返回值（统一结构，status区分状态）
 */
export interface SendResult {
  status: "success" | "error" | "pending";
  /** 角色 */
  role: "assistant";
  /** 内容（pending时可能为空） */
  content: string;
  /** thinking内容（可选） */
  thinking?: string;
  /** 会话线程ID */
  threadId: string;
  /** 待确认的tool信息（仅pending状态） */
  pendingTool?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  /** 原始响应（可选） */
  raw?: unknown;
}

/**
 * 创建中间件上下文
 */
function createMiddlewareContextBase(
  sessionId: string,
  config: ClientConfigBase,
  isStream: boolean,
  adapters: AdaptersGroup,
  toolManager: ToolManager,
  threadId: string,
  input: string,
): MiddlewareContext {
  return {
    session: { sessionId, threadId },
    request: { input, isStream },
    config,
    adapters,
    process: {
      history: [],
      messages: [],
      accumulated: "",
      thinkingAccumulated: "",
      chunkCount: 0,
    },
    tools: {
      toolManager,
      toolCallAccumulated: new Map(),
      pendingToolCalls: undefined,
      supervisionLevel: config.autoExecuteLevel ?? 1,
    },
    response: {
      raw: undefined,
      finalContent: "",
      finalThinking: undefined,
      finalResponse: undefined,
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
  constructor(
    private sessionId: string,
    private config: ClientConfigBase,
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

  /**
   * 确认执行待定的 tool 调用
   * @param threadId 会话线程ID（从 SendResult.threadId 获取）
   * @param approved 用户是否批准执行
   * @param interruptInfo 中断信息（从 SendResult.pendingTool 获取）
   */
  async confirmToolCall(
    threadId: string,
    approved: boolean,
    interruptInfo: {
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    },
  ): Promise<SendResult> {
    // 重建上下文，保留中断信息
    const ctx = createMiddlewareContextBase(
      this.sessionId,
      this.config,
      false,
      this.adapters,
      this.tool,
      threadId,
      approved ? "" : "用户拒绝",
    );
    ctx.state.interruptInfo = interruptInfo;
    ctx.state.needInterrupt = true;

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
            threadId: chunk.threadId,
          };
          break;
        }
      }

      if (interrupted && newInterrupt) {
        return {
          status: "pending",
          role: "assistant",
          content: "",
          threadId,
          pendingTool: newInterrupt,
        };
      }

      const doneChunk = chunks.find((c) => c.type === "staged");
      if (doneChunk && doneChunk.type === "staged") {
        return {
          status: "success",
          role: "assistant",
          content: doneChunk.content,
          ...(doneChunk.thinking && { thinking: doneChunk.thinking }),
          threadId,
          raw: doneChunk.raw,
        };
      }
    }

    return {
      status: "success",
      role: "assistant",
      content: ctx.response.finalContent,
      ...(ctx.response.finalThinking && {
        thinking: ctx.response.finalThinking,
      }),
      threadId,
      raw: ctx.response.raw,
    };
  }

  /**
   * 发送消息（两阶段执行）
   */
  async send(threadId: string, input: string): Promise<SendResult[]> {
    const ctx = createMiddlewareContextBase(
      this.sessionId,
      this.config,
      false,
      this.adapters,
      this.tool,
      threadId,
      input,
    );
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
          threadId: threadId,
        };
        break;
      }
    }

    if (interrupted && interruptInfo) {
      return [{
        status: "pending",
        role: "assistant",
        content: "",
        threadId,
        pendingTool: interruptInfo,
      }];
    }

    // 查找最后一次的 staged chunk（retry 后可能存在多个）
    const stagedChunks = chunks.filter((c) => c.type === "staged");
    return stagedChunks.map(el => ({
        status: "success",
        role: "assistant",
        content: el.content,
        ...(el.thinking && { thinking: el.thinking }),
        threadId,
        raw: el.raw,
    }))
    // if (stagedChunks.length) {
    //   return {
    //     status: "success",
    //     role: "assistant",
    //     content: doneChunk.content,
    //     ...(doneChunk.thinking && { thinking: doneChunk.thinking }),
    //     threadId,
    //     raw: doneChunk.raw,
    //   };
    // }

    // return {
    //   status: "success",
    //   role: "assistant",
    //   content: ctx.response.finalContent,
    //   ...(ctx.response.finalThinking && {
    //     thinking: ctx.response.finalThinking,
    //   }),
    //   threadId,
    //   raw: ctx.response.raw,
    // };
  }

  /**
   * 发送消息（流式）
   */
  async *sendStream(
    threadId: string,
    input: string,
  ): AsyncGenerator<LLMStreamChunk<unknown>> {
    const ctx = createMiddlewareContextBase(
      this.sessionId,
      this.config,
      true,
      this.adapters,
      this.tool,
      threadId,
      input,
    );

    const streamId = `stream-${Date.now()}`;
    const generator = this.middlewareChain(ctx);
    for await (const chunk of generator) {
      if (chunk.type === "stream") {
        yield {
          streamId,
          thinkingDelta: chunk.thinkingDelta,
          thinkingAccumulated: chunk.thinkingAccumulated,
          delta: chunk.delta,
          accumulated: chunk.accumulated,
          isDone: false,
          raw: chunk.raw,
        };
      } else if (chunk.type === "interrupt") {
        // 流式模式下的工具中断（暂不支持两阶段确认）
        // 直接自动执行
        yield {
          streamId,
          thinkingDelta: "",
          thinkingAccumulated: ctx.process.thinkingAccumulated,
          delta: "",
          accumulated: ctx.process.accumulated,
          isDone: false,
          raw: { type: "interrupt", toolName: chunk.toolName },
        };
      } else if (chunk.type === "staged") {
        yield {
          streamId,
          thinkingDelta: "",
          thinkingAccumulated: ctx.process.thinkingAccumulated,
          delta: "",
          accumulated: ctx.process.accumulated,
          isDone: false,
          raw: chunk.raw,
        };
      } else if (chunk.type === "done") {
        yield {
          streamId,
          thinkingDelta: "",
          thinkingAccumulated: ctx.process.thinkingAccumulated,
          delta: "",
          accumulated: ctx.process.accumulated,
          isDone: true,
          raw: "",
        };
      }
    }
  }
}
