import type { MiddlewareContext, MiddlewareChunk, StreamChunk, DoneChunk } from "./types";

/**
 * Chunk Middleware
 * 职责：流式数据组装（delta/thinking/tool_calls）
 * 仅在流式模式下生效
 */
export async function* chunkMiddleware(
  ctx: MiddlewareContext,
  next: () => Promise<void> | AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  if (!ctx.request.isStream) {
    const generator = next() as AsyncGenerator<MiddlewareChunk>;
    for await (const chunk of generator) {
      if (chunk.type === "done") {
        ctx.response.finalContent = chunk.content;
        ctx.response.finalThinking = chunk.thinking;
      }
      yield chunk;
    }
    return;
  }

  // 流式模式：处理 chunks
  ctx.process.accumulated = "";
  ctx.process.thinkingAccumulated = "";
  ctx.process.chunkCount = 0;
  ctx.tools.toolCallAccumulated = new Map();
  const streamId = `stream-${Date.now()}`;

  const generator = next() as AsyncGenerator<MiddlewareChunk>;
  for await (const chunk of generator) {
    ctx.process.chunkCount++;

    // 处理原始流式 chunk
    if (chunk.type === "stream") {
      // 从原始数据提取 delta
      const rawChunk = chunk.raw;
      const delta = extractDelta(ctx, rawChunk);
      ctx.process.accumulated += delta;

      const thinkingDelta = extractThinking(ctx, rawChunk);
      ctx.process.thinkingAccumulated += thinkingDelta;

      // 累积工具调用增量
      processToolCallDelta(ctx, rawChunk);

      // 组装后 yield
      const assembledChunk: StreamChunk = {
        type: "stream",
        streamId,
        thinkingDelta,
        delta,
        thinkingAccumulated: ctx.process.thinkingAccumulated,
        accumulated: ctx.process.accumulated,
        raw: rawChunk,
      };
      yield assembledChunk;
    }
  }

  // 流式完成
  const doneChunk: DoneChunk = {
    type: "done",
    content: ctx.process.accumulated,
    thinking: ctx.process.thinkingAccumulated,
    threadId: ctx.session.threadId,
    raw: null,
  };
  ctx.response.finalContent = ctx.process.accumulated;
  ctx.response.finalThinking = ctx.process.thinkingAccumulated;
  yield doneChunk;
}

/**
 * 提取 delta
 */
function extractDelta(ctx: MiddlewareContext, raw: unknown): string {
  return ctx.adapters.messageAdapter.extractStreamDelta(raw);
}

/**
 * 提取 thinking
 */
function extractThinking(ctx: MiddlewareContext, raw: unknown): string {
  return ctx.adapters.messageAdapter.extractStreamThinking?.(raw) ?? "";
}

/**
 * 处理工具调用增量
 */
function processToolCallDelta(ctx: MiddlewareContext, raw: unknown): void {
  // 通过 ToolAdapter 提取
  // 累积到 ctx.tools.toolCallAccumulated
}