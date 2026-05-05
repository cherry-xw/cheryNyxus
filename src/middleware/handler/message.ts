import type { MiddlewareContext, MiddlewareChunk, StagedChunk } from "../types";
import type { LLMResponse } from "@/message/index";
import { RetryState } from "../types";
import { v4 as uuid } from "uuid";

/**
 * 累积消息到历史
 */
function accumulateMessage(
  history: LLMResponse[],
  message: LLMResponse,
): LLMResponse[] {
  const sameThreadIndex = history.findIndex(
    (item) => item.threadId === message.threadId,
  );
  if (sameThreadIndex >= 0) {
    message.createdAt = history[sameThreadIndex]!.createdAt;
    history[sameThreadIndex] = message;
  } else {
    history.push(message);
  }
  return history;
}

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
  const { messageAdapter } = ctx.adapters;

  // === 前半部分：创建用户消息 + 累积历史（重试时跳过） ===
  const isRetry = ctx.state.retryState !== RetryState.none;

  if (!isRetry) {
    // 首次执行：创建用户消息 + 累积历史
    const now = Date.now();
    ctx.process.history = accumulateMessage(ctx.process.history, {
      id: uuid(),
      role: "user",
      threadId: ctx.session.threadId,
      content: ctx.request.input,
      createdAt: now,
      updateAt: now,
      raw: undefined,
      provider: "user",
    });
  }

  // === 调用下一层 ===
  const generator = next() as AsyncGenerator<MiddlewareChunk>;
  for await (const chunk of generator) {
    if (chunk.type === "stream" || chunk.type === "interrupt") {
      // stream/interrupt 立即传递，保持流式特性
      yield chunk;
    } else if (chunk.type === "staged") {
      // staged 立即 yield，保持顺序
      yield chunk;
    }
  }

  // === 后半部分：累积 assistant 消息 + tool 结果 ===

  // 2. 检查是否有 tool 执行结果
  const hasToolResults = Array.from(
    ctx.tools.toolCallAccumulated.values(),
  ).some((acc) => acc.executionResult !== undefined);
  console.log("hasToolResults");
  console.log(hasToolResults);
  // 3. 先累积 assistant content 消息到 history（有 tool results 时）
  if (hasToolResults && ctx.response.finalContent) {
    const assistantResponse = messageAdapter.wrapFinalResponse(
      ctx.session.threadId,
      ctx.response.finalContent,
      ctx.response.finalThinking,
      ctx.response.raw,
    );
    ctx.process.history = accumulateMessage(
      ctx.process.history,
      assistantResponse,
    );
  }

  // 4. 累积所有 tool 结果消息到 history
  if (hasToolResults) {
    for (const [, accumulator] of ctx.tools.toolCallAccumulated) {
      if (accumulator.executionResult) {
        const { toolCallId, success, result, error } =
          accumulator.executionResult;
        const content = success
          ? typeof result === "string"
            ? result
            : JSON.stringify(result)
          : `Tool execution failed: ${error}`;
        const now = Date.now();
        ctx.process.history = accumulateMessage(
          ctx.process.history,
          {
            id: uuid(),
            role: "tool",
            content,
            threadId: ctx.session.threadId,
            createdAt: now,
            updateAt: now,
            raw: { toolCallId },
            provider: "tool",
          },
        );
      }
    }

    // 清空 toolCallAccumulated 防止下一轮重复累积
    ctx.tools.toolCallAccumulated.clear();

    // 设置重试状态，重新执行中间件链
    ctx.state.retryState = RetryState.retryMessage;
    return;
  }

  // 5. 无 tool results，重置 retryState
  ctx.state.retryState = RetryState.none;

  // yield done 标记结束
  yield { type: "done", threadId: ctx.session.threadId };
}
