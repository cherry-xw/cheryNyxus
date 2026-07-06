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
import { LogLevel } from "@/utils/logger/types.js";

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
      logger.event("staged", {
        stagedType: staged.stagedType,
        senseName: staged.senseName,
        senseCallId: staged.id,
        contentLen: staged.content.length,
        thinkingLen: staged.thinking.length,
      });
      yield createChunk("staged", rid, stagedData);
    } else if (chunk.type === "sense_end") {
      const sc = chunk as SenseTriggerChunk;
      logger.event("sense.trigger", {
        senseCallId: sc.id,
        name: sc.name,
        supervisionLevel: sc.supervisionLevel,
        needsApproval: sc.supervisionLevel > SupervisionLevel.auto,
        argsLen: sc.arguments.length,
      });

      yield createNotification("interrupt", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        arguments: sc.arguments,
        supervisionLevel: sc.supervisionLevel,
        needsApproval: sc.supervisionLevel > SupervisionLevel.auto,
      });
    } else if (chunk.type === "sense_accept") {
      const sc = chunk as SenseAcceptChunk;
      logger.event("sense.result", {
        senseCallId: sc.id,
        name: sc.name,
        resultLen: sc.result.length,
        hash: sc.hash,
      });
      yield createNotification("accept", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        result: sc.result,
      });
    } else if (chunk.type === "sense_reject") {
      const sc = chunk as SenseRejectChunk;
      logger.event("sense.rejected", {
        senseCallId: sc.id,
        name: sc.name,
        reason: sc.reason,
      });
      yield createNotification("rejected", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        reason: sc.reason,
      });
    } else if (chunk.type === "consumed") {
      const count = (chunk as { count?: number }).count || 0;
      logger.event("input.consumed", { count });
      yield createNotification("consumed", rid, { count });
    } else if (chunk.type === "error") {
      const e = chunk as { errors: Array<{ message: string }> };
      const message = e.errors[0]?.message || "Unknown error";
      logger.event("chat.run.error", { message }, LogLevel.error);
      yield createNotification("error", rid, { message });
    } else if (chunk.type === "done") {
      logger.event("chat.run.done");
      yield createNotification("done", rid, null);
    } else if (chunk.type === "message_updated") {
      // kind:"replace" 的 message_updated = 感官去重命中（observeAgentChunks 已落库），
      // 转 "replaced" notification 通知 web 实时更新历史 sense block；content kind 不传 web。
      const u = chunk as MessageUpdatedChunk;
      if (u.patch.kind === "replace") {
        logger.event("message.replaced", { messageId: u.id, by: u.patch.replace.by });
        yield createNotification("replaced", rid, {
          id: u.id,
          content: u.patch.content,
          originalContent: u.patch.originalContent,
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
