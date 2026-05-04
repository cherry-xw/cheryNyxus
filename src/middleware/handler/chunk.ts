import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
  StagedChunk,
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
  if (!ctx.request.isStream) {
    const generator = next() as AsyncGenerator<MiddlewareChunk>;
    for await (const chunk of generator) {
      if (chunk.type === "staged") {
        ctx.response.finalContent = chunk.content;
        ctx.response.finalThinking = chunk.thinking;
        // 非流式模式：统一提取 toolCall 并存储到 toolCallAccumulated
        extractToolCallsFromResponse(ctx, ctx.response.raw);
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
  const streamId = `stream-${uuid()}`;

  const generator = next() as AsyncGenerator<MiddlewareChunk>;
  for await (const chunk of generator) {
    ctx.process.chunkCount++;

    // 处理原始流式 chunk
    if (chunk.type === "stream") {
      // 从原始数据提取 delta
      const rawChunk = chunk.raw;
      // console.log("\n=== RAW CHUNK ===");
      // console.log(JSON.stringify(rawChunk, null, 2));
      const delta = ctx.adapters.messageAdapter.extractStreamDelta(rawChunk);
      ctx.process.accumulated += delta;

      const thinkingDelta =
        ctx.adapters.messageAdapter.extractStreamThinking?.(rawChunk) ?? "";
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
  const stagedChunk: StagedChunk = {
    type: "staged",
    content: ctx.process.accumulated,
    thinking: ctx.process.thinkingAccumulated,
    threadId: ctx.session.threadId,
    raw: null,
  };
  ctx.response.finalContent = ctx.process.accumulated;
  ctx.response.finalThinking = ctx.process.thinkingAccumulated;
  yield stagedChunk;
}

/**
 * 处理工具调用增量（流式模式）
 */
function processToolCallDelta(ctx: MiddlewareContext, raw: unknown): void {
  const toolAdapter = ctx.adapters.toolAdapter;
  const deltas = toolAdapter.extractToolCallDeltas(raw);

  // Ollama id 为空时生成唯一 id
  let key = `tool-${uuid()}`;
  for (const delta of deltas) {
    const id = toolAdapter.getToolCallDeltaId(delta);
    const name = toolAdapter.getToolCallDeltaName(delta) ?? "";
    const argsDelta = toolAdapter.getToolCallDeltaArguments(delta);

    if (id) {
      key = id;
    }
    const existing = ctx.tools.toolCallAccumulated.get(key);
    if (existing) {
      // 累积 arguments（增量模式）
      if (argsDelta) {
        existing.arguments += argsDelta;
      }
      // name 可能只在首个 delta 出现，后续 delta 可能为空
      if (name && !existing.name) {
        existing.name = name;
      }
    } else {
      // 初始化累积器
      ctx.tools.toolCallAccumulated.set(key, {
        id: key,
        name,
        arguments: argsDelta ?? "",
      });
    }
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

  // Ollama id 为空时生成唯一 id
  let key = `tool-${uuid()}`;

  for (const tc of toolCalls) {
    const id = toolAdapter.getToolCallId(tc);
    const name = toolAdapter.getToolCallName(tc);
    const args = toolAdapter.getToolCallArguments(tc);

    if (id) {
      key = id;
    }

    ctx.tools.toolCallAccumulated.set(key, {
      id: key,
      name,
      arguments: args,
    });
  }
}
