import type { MiddlewareContext } from "@/core/middleware/types";

/**
 * 流式 chunk
 */
export interface StreamChunk {
  type: "stream";
  /** 思考增量 */
  thinkingDelta: string;
  /** 响应增量 */
  contentDelta: string;
  thinkingAccumulated: string;
  contentAccumulated: string;
  raw: unknown;
}

/**
 * 阶段性结果 chunk（中间状态，非最终完成）
 */
export interface StagedChunk {
  type: "staged";
  content: string;
  thinking?: string;
  raw: unknown;
}

/**
 * Chunk Middleware
 * 职责：流式数据组装（delta/thinking/tool_calls）
 * 仅在流式模式下生效
 */
export async function* chunkMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<unknown>,
): AsyncGenerator<StreamChunk | StagedChunk | unknown> {
  if (!ctx.global.stream) {
    const generator = next();
    for await (const chunk of generator) {
      if (isStagedChunk(chunk)) {
        // 非流式模式：统一提取 toolCall 并存储到 toolCallAccumulated
        extractToolCallsFromResponse(ctx, chunk.raw);
      }
      yield chunk;
    }
    return;
  }

  // 流式模式：处理 chunks
  ctx.process.contentAccumulated = "";
  ctx.process.thinkingAccumulated = "";
  ctx.process.chunkCount = 0;

  // 临时缓存所有 chunks
  const chunksBuffer: unknown[] = [];

  const generator = next();
  const { extractStreamDelta, extractStreamThinking } = ctx.adapters.messageAdapter;
  for await (const chunk of generator) {
    ctx.process.chunkCount++;

    // 处理原始流式 chunk
    if (isStreamChunk(chunk)) {
      // 从原始数据提取 delta
      const rawChunk = chunk.raw;
      chunksBuffer.push(rawChunk);

      const contentDelta = extractStreamDelta(rawChunk);
      ctx.process.contentAccumulated += contentDelta;

      const thinkingDelta = extractStreamThinking?.(rawChunk) ?? "";
      ctx.process.thinkingAccumulated += thinkingDelta;

      // 组装后 yield
      const assembledChunk: StreamChunk = {
        type: "stream",
        thinkingDelta,
        contentDelta,
        thinkingAccumulated: ctx.process.thinkingAccumulated,
        contentAccumulated: ctx.process.contentAccumulated,
        raw: rawChunk,
      };
      yield assembledChunk;
    } else {
      // 透传其他类型的 chunk
      yield chunk;
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
  yield stagedChunk;
}

/**
 * 类型守卫：判断是否为 StreamChunk
 */
function isStreamChunk(chunk: unknown): chunk is StreamChunk {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    (chunk as StreamChunk).type === "stream"
  );
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

  // 存储到 toolCallAccumulated（添加 triggeredAt）
  for (const tc of toolCalls) {
    ctx.process.toolCallAccumulated.set(tc.tid, {
      tid: tc.tid,
      name: tc.name ?? "",
      arguments: tc.arguments,
      triggeredAt: Date.now(),
      approved: false,
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
      triggeredAt: Date.now(),
      approved: false,
    });
  }
}