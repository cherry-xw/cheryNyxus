import type { MiddlewareContext, MiddlewareChunk, StagedChunk } from "../types";
import type { LLMResponse } from "@/message/index";
import { RetryState } from "../types";
import { v4 as uuid } from "uuid";

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
  console.log("\nhasToolResults", hasToolResults);
  // 3. 先累积 assistant content 消息到 history（有 tool results 时）
  if (hasToolResults && ctx.response.finalContent) {
    const raw = ctx.response.raw as any;
    ctx.process.history.push({
      id: raw?.id ?? `${Date.now()}`,
      role: "assistant",
      content: ctx.response.finalContent,
      createdAt: Date.now(),
      updateAt: Date.now(),
      raw: raw ?? null,
      thinking: ctx.response.finalThinking,
    });
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
        ctx.process.history.push({
          id: uuid(),
          role: "tool",
          content,
          createdAt: now,
          updateAt: now,
          raw: { toolCallId },
        });
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
  yield { type: "done" };
}
