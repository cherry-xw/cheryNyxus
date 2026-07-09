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
import { computeContextUsage } from "@/utils/token.js";
import config from "@/utils/config.js";
import { getChat, updateChatMetadata } from "@/db/chat.js";

/**
 * 将 agent generator 的 MiddlewareChunk 转换为 WebSocket 协议的 Chunk/Notification
 * （P2-1 从 send.ts 拆出）。handleChatSend 和 handleChatResume 共用。
 *
 * chatId 用于 done notification 时计算 contextUsage（CP7）：跑完一轮 loop 后实时
 * 重算 chat 总 token / brain.contextLimit 推送给前端，ContextBar 随每轮更新。
 */
export async function* streamAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  rid: string,
  chatId: string,
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
      const needsApproval = sc.supervisionLevel > SupervisionLevel.auto;
      logger.event("sense.trigger", {
        senseCallId: sc.id,
        name: sc.name,
        supervisionLevel: sc.supervisionLevel,
        needsApproval,
        argsLen: sc.arguments.length,
      });

      // auto sense（spawn_subagent/read_file 等）不推 interrupt：
      // 无审批需求，前端不弹审核卡（与 auto 逻辑一致）。interrupt 仅 confirm/manual 推送，
      // 携带 waitTime（= global.approval_timeout）+ createdAt 供前端倒计时。
      // approval_timeout 缺省 → waitTime=0（不超时，前端不显倒计时）。
      if (needsApproval) {
        yield createNotification("interrupt", rid, {
          approvalId: sc.id,
          senseName: sc.name,
          arguments: sc.arguments,
          supervisionLevel: sc.supervisionLevel,
          needsApproval,
          waitTime: config.global.approval_timeout ?? 0,
          createdAt: Date.now(),
        });
      }
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
      // CP7：done 时重算 contextUsage 推送前端，ContextBar 每轮 loop 后实时更新
      const contextUsage = computeContextUsage(chatId);
      // 子 agent done（parent_chat_id 非空）：标 metadata.finished（ghost 标记，前端转灵魂态；chat 保留供查历史）
      const chat = getChat(chatId);
      const finished = !!chat?.parent_chat_id;
      if (finished) updateChatMetadata(chatId, { finished: true });
      logger.event("chat.run.done", { contextUsage, finished });
      yield createNotification("done", rid, finished ? { contextUsage, finished: true } : { contextUsage });
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
