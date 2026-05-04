import type { MiddlewareContext, MiddlewareChunk } from "./types";
import { MessageAdapter } from "@/message/index";
import { RetryState } from "./types";

/**
 * Message Middleware
 * 职责：
 * 1. 消息累积、历史构建（前半部分，重试时跳过）
 * 2. 累积工具结果消息到 history（后半部分）
 * 3. 触发重试（后半部分）
 * 4. 累积最终响应（后半部分）
 */
export async function* messageMiddleware(
  ctx: MiddlewareContext,
  next: () => Promise<void> | AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  const messageAdapter = new MessageAdapter(ctx.sessionId, ctx.config.provider);

  // === 前半部分：创建用户消息 + 累积历史（重试时跳过） ===
  const isRetry = ctx.retryState !== RetryState.none;

  if (!isRetry) {
    // 首次执行：创建用户消息 + 累积历史
    const userMessage = messageAdapter.createUserMessage(ctx.threadId, ctx.input);
    ctx.history = messageAdapter.accumulate(userMessage);
  }

  // === 调用下一层 ===
  const generator = next() as AsyncGenerator<MiddlewareChunk>;
  for await (const chunk of generator) {
    yield chunk;
  }

  // === 后半部分：累积 assistant 消息 + tool 结果 ===

  // 1. 检查是否有 tool 执行结果
  const hasToolResults = Array.from(ctx.toolCallAccumulated.values()).some(
    (acc) => acc.executionResult !== undefined,
  );

  // 2. 先累积 assistant content 消息到 history（有 tool results 时）
  if (hasToolResults && ctx.finalContent) {
    const assistantResponse = messageAdapter.getAdapter().wrapFinalResponse(
      ctx.threadId,
      ctx.finalContent,
      ctx.finalThinking,
      ctx.response,
    );
    ctx.history = messageAdapter.accumulate(assistantResponse);
  }

  // 3. 累积所有 tool 结果消息到 history
  if (hasToolResults) {
    for (const [, accumulator] of ctx.toolCallAccumulated) {
      if (accumulator.executionResult) {
        const { toolCallId, success, result, error } = accumulator.executionResult;
        const content = success
          ? typeof result === "string" ? result : JSON.stringify(result)
          : `Tool execution failed: ${error}`;

        const toolResultMessage = messageAdapter.createToolResultMessage(
          ctx.threadId,
          toolCallId,
          content,
        );
        ctx.history = messageAdapter.accumulate(toolResultMessage);
      }
    }

    // 清空 toolCallAccumulated 和 pendingToolCalls，防止下一轮重复累积
    ctx.toolCallAccumulated.clear();
    ctx.pendingToolCalls = undefined;

    // 设置重试状态，重新执行中间件链
    ctx.retryState = RetryState.retryMessage;
    return;
  }

  // 5. 重试完成后重置 retryState
  ctx.retryState = RetryState.none;
}