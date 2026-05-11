import type { MiddlewareContext, MiddlewareChunk, StagedChunk } from "@/core/middleware/types";
import { v4 as uuid } from "uuid";

/**
 * Message Middleware
 * 职责：
 * 1. 消息累积、历史构建
 * 2. 累积 assistant 消息到 history（仅 content/thinking，toolCalls 由 tool 层更新）
 */
export async function* messageMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // === 调用下一层 ===
  const generator = next();
  for await (const chunk of generator) {
    yield chunk;
    if (chunk.type === "staged") {
      // staged: 无 tool call 时 push assistant（有 tool call 由 tool.ts 处理）
      if (ctx.process.toolCallAccumulated.size === 0) {
        ctx.process.history.push({
          id: uuid(),
          role: "assistant",
          content: chunk.content || "",
          thinking: chunk.thinking,
          toolCalls: [],
          createdAt: Date.now(),
          updateAt: Date.now(),
          raw: chunk.raw ?? null,
        });
      }
    }
  }

  // yield done 标记结束
  yield { type: "done" };
}