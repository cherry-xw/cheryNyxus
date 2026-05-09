import type { MiddlewareChunk, MessageStreamChunk, InterruptChunk } from "./types";

/**
 * 将 MiddlewareChunk[] 整合为 MessageStreamChunk[]
 * 供需要整合结果的消费者使用
 */
export function aggregateChunks(
  chunks: MiddlewareChunk[],
): MessageStreamChunk[] {
  const result: MessageStreamChunk[] = [];

  for (const chunk of chunks) {
    switch (chunk.type) {
      case "stream":
        result.push({
          status: "success",
          thinkingDelta: chunk.thinkingDelta,
          thinking: chunk.thinkingAccumulated,
          contentDelta: chunk.contentDelta,
          content: chunk.contentAccumulated,
          raw: chunk.raw,
        });
        break;

      case "interrupt": {
        const ic = chunk as InterruptChunk;
        result.push({
          status: "pending",
          thinkingDelta: "",
          contentDelta: "",
          content: "",
          pendingTool: {
            toolCallId: ic.toolCallId,
            toolName: ic.toolName,
            args: ic.args,
          },
          raw: undefined,
        });
        break;
      }

      case "staged":
        result.push({
          status: "success",
          thinkingDelta: "",
          thinking: chunk.thinking,
          contentDelta: "",
          content: chunk.content,
          raw: chunk.raw,
        });
        break;

      case "done":
        result.push({
          status: "success",
          thinkingDelta: "",
          contentDelta: "",
          content: "",
          raw: "",
        });
        break;
    }
  }

  return result;
}