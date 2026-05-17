import type { MiddlewareContext, DoneChunk } from "@/core/middleware/types";
import { v4 as uuid } from "uuid";
import type { StagedChunk } from "./chunk";

/**
 * Message Middleware
 * 职责：
 * 1. 消息累积、历史构建
 * 2. 累积 assistant 消息到 history（仅 content/thinking，toolCalls 由 tool 层更新）
 */
export async function* messageMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<unknown>,
): AsyncGenerator<DoneChunk | unknown> {
  // === 调用下一层 ===
  const generator = next();
  for await (const chunk of generator) {
    yield chunk;
    if (isStagedChunk(chunk)) {
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

/**
 * 类型守卫：判断是否为 StagedChunk
 */
function isStagedChunk(chunk: unknown): chunk is StagedChunk {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as StagedChunk).type === "staged"
  );
}