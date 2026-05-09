import type { MiddlewareContext, MiddlewareChunk, StagedChunk } from "../types";
import type { LLMResponse, ToolCallInfo } from "@/message/index";
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

  // interrupt状态下，中止执行流，不进入retry逻辑
  if (ctx.state.needInterrupt) {
    return;
  }

  // 检查是否有 tool 执行结果
  const hasToolResults = Array.from(
    ctx.process.toolCallAccumulated.values(),
  ).some((acc) => acc.executionResult !== undefined);
  console.log("\nhasToolResults", hasToolResults);

  // 检查是否有 tool calls（无论是否有 content）
  const hasToolCalls = ctx.process.toolCallAccumulated.size > 0;
  console.log("hasToolCalls", hasToolCalls);
  console.log("toolCallAccumulated", Array.from(ctx.process.toolCallAccumulated.values()));

  // 3. 先累积 assistant 消息到 history（有 tool calls 时必须累积）
  if (hasToolCalls) {
    // 提取 tool_calls 信息（按 ID 去重）
    const toolCalls: ToolCallInfo[] = Array.from(
      ctx.process.toolCallAccumulated.values(),
    )
      .filter((acc) => acc.name) // 只取有 name 的（完整 tool call）
      .map((acc) => ({
        id: acc.id ?? `call_${Date.now()}`,
        name: acc.name,
        arguments: acc.arguments,
      }))
      .filter((tc, index, arr) =>
        arr.findIndex(t => t.id === tc.id) === index
      ); // 按 ID 去重

    const raw = ctx.response.raw as any;
    ctx.process.history.push({
      id: raw?.id ?? `${Date.now()}`,
      role: "assistant",
      content: ctx.response.finalContent || "", // 可能为空
      thinking: ctx.response.finalThinking,
      toolCalls,
      createdAt: Date.now(),
      updateAt: Date.now(),
      raw: raw ?? null,
    });
  }

  // 4. 累积所有 tool 结果消息到 history
  if (hasToolResults) {
    for (const [, accumulator] of ctx.process.toolCallAccumulated) {
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
    ctx.process.toolCallAccumulated.clear();

    // 设置重试状态，重新执行中间件链
    ctx.state.retryState = RetryState.retryMessage;
    return;
  }

  // 5. 无 tool results，重置 retryState
  ctx.state.retryState = RetryState.none;

  // yield done 标记结束
  yield { type: "done" };
}
