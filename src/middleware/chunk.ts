import type { MiddlewareContext, MiddlewareChunk, StreamChunk, DoneChunk } from "./types";
import { getMessageProviderAdapterConfig } from "@/message/adapter";

/**
 * Chunk Middleware
 * 职责：流式数据组装（delta/thinking/tool_calls）
 * 仅在流式模式下生效
 */
export async function* chunkMiddleware(
  ctx: MiddlewareContext,
  next: () => Promise<void> | AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // 非流式模式：处理 DoneChunk 设置 finalContent
  if (!ctx.isStream) {
    const generator = next() as AsyncGenerator<MiddlewareChunk>;
    for await (const chunk of generator) {
      if (chunk.type === "done") {
        ctx.finalContent = chunk.content;
        ctx.finalThinking = chunk.thinking;
      }
      yield chunk;
    }
    return;
  }

  // 流式模式：处理 chunks
  ctx.accumulated = "";
  ctx.thinkingAccumulated = "";
  ctx.chunkCount = 0;
  ctx.toolCallAccumulated = new Map();
  const streamId = `stream-${Date.now()}`;

  const generator = next() as AsyncGenerator<MiddlewareChunk>;
  for await (const chunk of generator) {
    ctx.chunkCount++;

    // 处理原始流式 chunk
    if (chunk.type === "stream") {
      // 从原始数据提取 delta
      const rawChunk = chunk.raw;
      const delta = extractDelta(ctx, rawChunk);
      ctx.accumulated += delta;

      const thinkingDelta = extractThinking(ctx, rawChunk);
      ctx.thinkingAccumulated += thinkingDelta;

      // 累积工具调用增量
      processToolCallDelta(ctx, rawChunk);

      // 组装后 yield
      const assembledChunk: StreamChunk = {
        type: "stream",
        streamId,
        thinkingDelta,
        delta,
        thinkingAccumulated: ctx.thinkingAccumulated,
        accumulated: ctx.accumulated,
        raw: rawChunk,
      };
      yield assembledChunk;
    }
  }

  // 流式完成
  const doneChunk: DoneChunk = {
    type: "done",
    content: ctx.accumulated,
    thinking: ctx.thinkingAccumulated,
    threadId: ctx.threadId,
    raw: null,
  };
  ctx.finalContent = ctx.accumulated;
  ctx.finalThinking = ctx.thinkingAccumulated;
  yield doneChunk;
}

/**
 * 提取 delta
 */
function extractDelta(ctx: MiddlewareContext, raw: unknown): string {
  const msgAdapter = getMessageProviderAdapterConfig(ctx.config.provider);
  if (!msgAdapter) {
    throw new Error(`Provider "${ctx.config.provider}" message adapter not registered`);
  }
  return msgAdapter.extractStreamDelta(raw);
}

/**
 * 提取 thinking
 */
function extractThinking(ctx: MiddlewareContext, raw: unknown): string {
  const msgAdapter = getMessageProviderAdapterConfig(ctx.config.provider);
  if (!msgAdapter) {
    throw new Error(`Provider "${ctx.config.provider}" message adapter not registered`);
  }
  return msgAdapter.extractStreamThinking?.(raw) ?? "";
}

/**
 * 处理工具调用增量
 */
function processToolCallDelta(ctx: MiddlewareContext, raw: unknown): void {
  // 通过 ToolAdapter 提取
  // 累积到 ctx.toolCallAccumulated
}