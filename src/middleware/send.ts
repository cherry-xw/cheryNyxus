import type { ClientConfigBase, SendResult } from "@/llm/types";
import type {
  MiddlewareContext,
  LLMStreamChunk,
} from "./types";
import { createDefaultMiddlewareChain, executeUntilInterrupt } from "./index";
import { continueToolExecution } from "./tool";
import { ToolManager } from "@/tool/index";
import { RetryState } from "./types";

/**
 * 创建中间件上下文
 */
function createMiddlewareContext(
  sessionId: string,
  threadId: string,
  input: string,
  config: ClientConfigBase,
  isStream: boolean,
  toolManager?: ToolManager,
): MiddlewareContext {
  const manager = toolManager ?? new ToolManager(config.provider);

  return {
    sessionId,
    threadId,
    input,
    config,
    isStream,
    history: [],
    messages: [],
    toolManager: manager,
    toolCallAccumulated: new Map(),
    supervisionLevel: config.autoExecuteLevel ?? 1,
    needInterrupt: false,
    accumulated: "",
    thinkingAccumulated: "",
    chunkCount: 0,
    response: undefined,
    streamIterator: undefined,
    options: undefined,
    finalContent: "",
    finalThinking: undefined,
    finalResponse: undefined,
    retryState: RetryState.none,
    pendingToolCalls: undefined,
  };
}

/**
 * 发送消息（非流式）
 * 使用中间件链处理请求
 */
export async function send(
  sessionId: string,
  threadId: string,
  input: string,
  config: ClientConfigBase,
  toolManager?: ToolManager,
): Promise<SendResult> {
  const ctx = createMiddlewareContext(sessionId, threadId, input, config, false, toolManager);
  const middlewareChain = createDefaultMiddlewareChain();

  const { chunks, interrupted, interruptInfo } = await executeUntilInterrupt(
    middlewareChain,
    ctx,
  );

  if (interrupted && interruptInfo) {
    return {
      status: "pending",
      role: "assistant",
      content: "",
      threadId,
      pendingTool: interruptInfo,
    };
  }

  // 查找 done chunk
  const doneChunk = chunks.find((c) => c.type === "done");
  if (doneChunk && doneChunk.type === "done") {
    return {
      status: "success",
      role: "assistant",
      content: doneChunk.content,
      ...(doneChunk.thinking && { thinking: doneChunk.thinking }),
      threadId,
      raw: doneChunk.raw,
    };
  }

  return {
    status: "success",
    role: "assistant",
    content: ctx.finalContent,
    ...(ctx.finalThinking && { thinking: ctx.finalThinking }),
    threadId,
    raw: ctx.response,
  };
}

/**
 * 发送消息（流式）
 * 使用中间件链处理请求，返回 AsyncGenerator
 */
export async function* sendStream(
  sessionId: string,
  threadId: string,
  input: string,
  config: ClientConfigBase,
  toolManager?: ToolManager,
): AsyncGenerator<LLMStreamChunk<unknown>> {
  const ctx = createMiddlewareContext(sessionId, threadId, input, config, true, toolManager);
  const middlewareChain = createDefaultMiddlewareChain();

  const streamId = `stream-${Date.now()}`;

  for await (const chunk of middlewareChain(ctx)) {
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
        thinkingAccumulated: ctx.thinkingAccumulated,
        delta: "",
        accumulated: ctx.accumulated,
        isDone: false,
        raw: { type: "interrupt", toolName: chunk.toolName },
      };
    } else if (chunk.type === "done") {
      yield {
        streamId,
        thinkingDelta: "",
        thinkingAccumulated: ctx.thinkingAccumulated,
        delta: "",
        accumulated: ctx.accumulated,
        isDone: true,
        raw: chunk.raw,
      };
    }
  }
}

/**
 * 确认执行待定的 tool 调用
 * 用于两阶段执行恢复
 */
export async function confirmToolCall(
  sessionId: string,
  threadId: string,
  config: ClientConfigBase,
  approved: boolean,
  interruptInfo: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  },
  toolManager?: ToolManager,
): Promise<SendResult> {
  // 重建上下文，保留中断信息
  const ctx = createMiddlewareContext(sessionId, threadId, "", config, false, toolManager);
  ctx.interruptInfo = interruptInfo;
  ctx.needInterrupt = true;

  // 执行工具调用（用户确认或拒绝）
  for await (const _ of continueToolExecution(ctx, approved)) {
    // 遍历 Generator 执行完毕
  }

  // 如果设置了回退状态，重新执行中间件链获取新响应
  if (ctx.retryState === RetryState.retryMessage) {
    ctx.retryState = RetryState.none;
    const middlewareChain = createDefaultMiddlewareChain();
    const { chunks, interrupted, interruptInfo: newInterrupt } = await executeUntilInterrupt(
      middlewareChain,
      ctx,
    );

    if (interrupted && newInterrupt) {
      return {
        status: "pending",
        role: "assistant",
        content: "",
        threadId,
        pendingTool: newInterrupt,
      };
    }

    const doneChunk = chunks.find((c) => c.type === "done");
    if (doneChunk && doneChunk.type === "done") {
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
    content: ctx.finalContent,
    ...(ctx.finalThinking && { thinking: ctx.finalThinking }),
    threadId,
    raw: ctx.response,
  };
}