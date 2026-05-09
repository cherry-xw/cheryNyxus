import type {
  MiddlewareContext,
  MiddlewareChunk,
  StagedChunk,
  StreamChunk
} from "../types";
import { v4 as uuid } from "uuid";

/**
 * Chunk Middleware
 * 职责：流式数据组装（delta/thinking/tool_calls）
 * 仅在流式模式下生效
 */
export async function* chunkMiddleware(
  ctx: MiddlewareContext,
  next: () => Promise<void> | AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  if (!ctx.global.stream) {
    const generator = next() as AsyncGenerator<MiddlewareChunk>;
    for await (const chunk of generator) {
      if (chunk.type === "staged") {
        ctx.response.finalContent = chunk.content.trim();
        ctx.response.finalThinking = chunk.thinking?.trim();
        // 非流式模式：统一提取 toolCall 并存储到 toolCallAccumulated
        extractToolCallsFromResponse(ctx, ctx.response.raw);
      }
      yield chunk;
    }
    return;
  }

  // 流式模式：处理 chunks
  ctx.process.contentAccumulated = "";
  ctx.process.thinkingAccumulated = "";
  ctx.process.chunkCount = 0;
  ctx.process.toolCallAccumulated = new Map();
  const streamId = `stream-${uuid()}`;

  // 临时缓存所有 chunks
  const chunksBuffer: unknown[] = [];

  const generator = next() as AsyncGenerator<MiddlewareChunk>;
  for await (const chunk of generator) {
    ctx.process.chunkCount++;

    // 处理原始流式 chunk
    if (chunk.type === "stream") {
      // 从原始数据提取 delta
      const rawChunk = chunk.raw;
      chunksBuffer.push(rawChunk);

      const delta = ctx.adapters.messageAdapter.extractStreamDelta(rawChunk);
      ctx.process.contentAccumulated += delta;

      const thinkingDelta =
        ctx.adapters.messageAdapter.extractStreamThinking?.(rawChunk) ?? "";
      ctx.process.thinkingAccumulated += thinkingDelta;

      // 组装后 yield
      const assembledChunk: StreamChunk = {
        type: "stream",
        streamId,
        thinkingDelta,
        delta,
        thinkingAccumulated: ctx.process.thinkingAccumulated,
        contentAccumulated: ctx.process.contentAccumulated,
        raw: rawChunk,
      };
      yield assembledChunk;
    }
  }
  ctx.process.contentAccumulated = ctx.process.contentAccumulated.trim();

  // 流式完成：整合 tool call chunks
  if (chunksBuffer.length > 0) {
    assembleAndExtractToolCalls(ctx, chunksBuffer);
  }

  // 流式完成
  const stagedChunk: StagedChunk = {
    type: "staged",
    content: ctx.process.contentAccumulated,
    thinking: ctx.process.thinkingAccumulated,
    raw: null,
  };
  ctx.response.finalContent = ctx.process.contentAccumulated;
  ctx.response.finalThinking = ctx.process.thinkingAccumulated;
  yield stagedChunk;
}

/**
 * 整合 tool call chunks 并提取 ToolCallData
 */
function assembleAndExtractToolCalls(
  ctx: MiddlewareContext,
  buffer: unknown[],
): void {
  const toolAdapter = ctx.adapters.toolAdapter;

  // 整合为 provider 原生格式
  const assembled = toolAdapter.assembleToolCallChunks(buffer);

  // 提取 ToolCallData
  const toolCalls = toolAdapter.extractToolCalls(assembled);

  // 存储到 toolCallAccumulated
  for (const tc of toolCalls) {
    ctx.process.toolCallAccumulated.set(tc.tid, {
      tid: tc.tid,
      name: tc.name ?? "",
      arguments: tc.arguments,
    });
  }
}

/**
 * 从非流式响应提取 toolCall 并存储
 */
function extractToolCallsFromResponse(
  ctx: MiddlewareContext,
  raw: unknown,
): void {
  if (!raw) return;

  const toolAdapter = ctx.adapters.toolAdapter;
  const toolCalls = toolAdapter.extractToolCalls(raw);

  for (const tc of toolCalls) {
    ctx.process.toolCallAccumulated.set(tc.tid, {
      tid: tc.tid,
      name: tc.name ?? "",
      arguments: tc.arguments,
    });
  }
}
