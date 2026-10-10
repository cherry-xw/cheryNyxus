/**
 * Chunk 收集与分类断言工具（集成式 agent 测试用）。
 *
 * MiddlewareChunk 是洋葱链 yield 的扁平事件（非 WS 帧），顶层即 type 字段。
 * 与 flows/eventsAssert 的 S2C 事件不同（那是 WS 编码后的 {kind,type,data}）。
 */
import type {
  MiddlewareChunk,
  StagedChunk,
  StreamChunk,
  SenseTriggerChunk,
  SenseAcceptChunk,
  SenseRejectChunk,
  SensePendingChunk,
  MessageCreatedChunk,
  MessageUpdatedChunk,
  ConsumedChunk,
  ErrorChunk,
} from "@/core/middleware/types";

/** 收集 generator 全部 chunk */
export async function collectChunks(
  gen: AsyncGenerator<MiddlewareChunk, void, unknown>,
): Promise<MiddlewareChunk[]> {
  const out: MiddlewareChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/** chunk.type 序列（便于断言流转顺序） */
export function chunkTypes(chunks: MiddlewareChunk[]): string[] {
  return chunks.map((c) => c.type);
}

/** staged.stagedType 序列（thinking_end/content_end/sense_end） */
export function stagedTypes(chunks: MiddlewareChunk[]): string[] {
  return chunks
    .filter((c): c is StagedChunk => c.type === "staged")
    .map((c) => c.stagedType);
}

/** 首个指定 type 的 chunk */
export function firstOfType<T extends MiddlewareChunk>(
  chunks: MiddlewareChunk[],
  type: T["type"],
): T | undefined {
  return chunks.find((c) => c.type === type) as T | undefined;
}

/** 全部指定 type 的 chunk */
export function filterType<T extends MiddlewareChunk>(
  chunks: MiddlewareChunk[],
  type: T["type"],
): T[] {
  return chunks.filter((c) => c.type === type) as T[];
}

/** 拼接所有 stream chunk 的 contentDelta */
export function collectContent(chunks: MiddlewareChunk[]): string {
  return chunks
    .filter((c): c is StreamChunk => c.type === "stream")
    .map((c) => c.contentDelta)
    .join("");
}

/** 拼接所有 stream chunk 的 thinkingDelta */
export function collectThinking(chunks: MiddlewareChunk[]): string {
  return chunks
    .filter((c): c is StreamChunk => c.type === "stream")
    .map((c) => c.thinkingDelta)
    .join("");
}

/** 所有 sense_end（SenseTriggerChunk） */
export function senseEnds(chunks: MiddlewareChunk[]): SenseTriggerChunk[] {
  return filterType<SenseTriggerChunk>(chunks, "sense_end");
}

/** 所有 sense_accept */
export function senseAccepts(chunks: MiddlewareChunk[]): SenseAcceptChunk[] {
  return filterType<SenseAcceptChunk>(chunks, "sense_accept");
}

/** 所有 sense_reject */
export function senseRejects(chunks: MiddlewareChunk[]): SenseRejectChunk[] {
  return filterType<SenseRejectChunk>(chunks, "sense_reject");
}

/** 所有 sense_pending（审批注册） */
export function sensePendings(chunks: MiddlewareChunk[]): SensePendingChunk[] {
  return filterType<SensePendingChunk>(chunks, "sense_pending");
}

/** 所有 message_created effect */
export function messageCreated(chunks: MiddlewareChunk[]): MessageCreatedChunk[] {
  return filterType<MessageCreatedChunk>(chunks, "message_created");
}

/** 所有 message_updated effect */
export function messageUpdated(chunks: MiddlewareChunk[]): MessageUpdatedChunk[] {
  return filterType<MessageUpdatedChunk>(chunks, "message_updated");
}

/** 首个 consumed */
export function firstConsumed(chunks: MiddlewareChunk[]): ConsumedChunk | undefined {
  return firstOfType<ConsumedChunk>(chunks, "consumed");
}

/** 首个 error */
export function firstError(chunks: MiddlewareChunk[]): ErrorChunk | undefined {
  return firstOfType<ErrorChunk>(chunks, "error");
}

/** 是否含 done */
export function hasDone(chunks: MiddlewareChunk[]): boolean {
  return chunks.some((c) => c.type === "done");
}
