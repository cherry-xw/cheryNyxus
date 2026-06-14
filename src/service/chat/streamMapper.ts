import {
  createChunk,
  createNotification,
  type Chunk,
  type Notification,
} from "../message/types.js";
import type {
  MiddlewareChunk,
  SenseTriggerChunk,
  SenseAcceptChunk,
  SenseRejectChunk,
  StagedChunk,
  MessageUpdatedChunk,
} from "@/core/middleware/types";
import { SupervisionLevel } from "@/core/config";
import { logger } from "@/utils/logger/index.js";

/**
 * 将 agent generator 的 MiddlewareChunk 转换为 WebSocket 协议的 Chunk/Notification
 * （P2-1 从 send.ts 拆出）。handleChatSend 和 handleChatResume 共用。
 */
export async function* streamAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  rid: string,
): AsyncGenerator<Chunk | Notification, void, unknown> {
  let seq = 0;

  for await (const chunk of generator) {
    if (chunk.type === "stream") {
      const streamData: Record<string, unknown> = {};
      if (chunk.thinkingDelta) {
        streamData.thinking = chunk.thinkingDelta;
      }
      if (chunk.contentDelta) {
        streamData.content = chunk.contentDelta;
      }
      if (chunk.senseDelta && chunk.senseDelta.length > 0) {
        streamData.senseCall = chunk.senseDelta;
      }
      yield createChunk("stream", rid, streamData, ++seq);
    } else if (chunk.type === "staged") {
      const staged = chunk as StagedChunk;
      const stagedData: Record<string, unknown> = {
        type: staged.stagedType,
      };
      if (staged.thinking) {
        stagedData.thinking = staged.thinking;
      }
      if (staged.content) {
        stagedData.content = staged.content;
      }
      if (staged.senseName) {
        stagedData.senseName = staged.senseName;
      }
      if (staged.senseArguments) {
        stagedData.arguments = staged.senseArguments;
      }
      if (staged.id) {
        stagedData.id = staged.id;
      }
      yield createChunk("staged", rid, stagedData);
    } else if (chunk.type === "sense_end") {
      const sc = chunk as SenseTriggerChunk;
      logger.info(`[Stream] sense_end, id=${sc.id}, name=${sc.name}, supervision=${sc.supervisionLevel}`);

      yield createNotification("interrupt", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        arguments: sc.arguments,
        supervisionLevel: sc.supervisionLevel,
        needsApproval: sc.supervisionLevel > SupervisionLevel.auto,
      });
    } else if (chunk.type === "sense_accept") {
      const sc = chunk as SenseAcceptChunk;
      logger.info(`[Stream] sense_accept, id=${sc.id}, name=${sc.name}`);
      yield createNotification("accept", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        result: sc.result,
      });
    } else if (chunk.type === "sense_reject") {
      const sc = chunk as SenseRejectChunk;
      logger.info(`[Stream] sense_reject, id=${sc.id}, name=${sc.name}`);
      yield createNotification("rejected", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        reason: sc.reason,
      });
    } else if (chunk.type === "consumed") {
      yield createNotification("consumed", rid, { count: (chunk as { count?: number }).count || 0 });
    } else if (chunk.type === "error") {
      const e = chunk as { errors: Array<{ message: string }> };
      yield createNotification("error", rid, { message: e.errors[0]?.message || "Unknown error" });
    } else if (chunk.type === "done") {
      logger.info(`[Stream] done`);
      yield createNotification("done", rid, null);
    } else if (chunk.type === "message_updated") {
      // 带 replace 的 message_updated = 感官去重命中（observeAgentChunks 已落库），
      // 转 "replaced" notification 通知 web 实时更新历史 sense block；非 replace 的不传 web。
      const u = chunk as MessageUpdatedChunk;
      if (u.patch.replace) {
        yield createNotification("replaced", rid, {
          id: u.id,
          content: u.patch.content ?? "",
          originalContent: u.patch.originalContent ?? "",
          by: u.patch.replace.by,
        });
      }
    } else if (
      chunk.type === "message_created" ||
      chunk.type === "sense_pending"
    ) {
      // 内部 effect chunk 应由 observeAgentChunks 消费，不进入传输层。
      continue;
    }
  }
}
