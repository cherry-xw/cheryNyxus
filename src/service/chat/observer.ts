import { addMessage, fillApprovalResult, markMessageReplaced } from "@/db/chat.js";
import { approvalManager } from "../approval/manager.js";
import type { LLMResponse } from "@/core/message/adapter";
import type { MiddlewareChunk } from "@/core/middleware/types";
import { logger } from "@/utils/logger/index.js";

/**
 * 统一消费 agent 内部 effect chunk（P2-1 从 send.ts 拆出）。
 * middleware 只产出事实流，service observer 在这里集中处理 DB/approval 副作用。
 */
export async function* observeAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  chatId: string,
  getMessages: () => LLMResponse[],
): AsyncGenerator<MiddlewareChunk, void, unknown> {
  // 历史消息（loadHistory 注入）视为已落库，避免 abort flush 时重复 INSERT 触发 UNIQUE 冲突。
  const syncedIds = new Set<string>(getMessages().map((m) => m.id));
  try {
    for await (const chunk of generator) {
      if (chunk.type === "message_created") {
        if (!syncedIds.has(chunk.message.id)) {
          addMessage(chunk.message.id, chatId, {
            role: chunk.message.role,
            content: chunk.message.content,
            thinking: chunk.message.thinking,
            senseCall: chunk.message.senseCalls,
            hash: chunk.message.hash,
          });
          syncedIds.add(chunk.message.id);
          logger.event("message.created", {
            messageId: chunk.message.id,
            role: chunk.message.role,
            contentLen: chunk.message.content?.length ?? 0,
            thinkingLen: chunk.message.thinking?.length ?? 0,
            senseCalls: chunk.message.senseCalls?.length,
            hash: chunk.message.hash,
          });
        }
        continue;
      }

      if (chunk.type === "message_updated") {
        if (chunk.patch.replace) {
          // 感官去重命中：content 改说明文字 + replace 状态 + originalContent 落库
          markMessageReplaced(chatId, chunk.id, {
            content: chunk.patch.content,
            replace: chunk.patch.replace,
            originalContent: chunk.patch.originalContent,
          });
          syncedIds.add(chunk.id);
          logger.event("message.replaced.db", { messageId: chunk.id, by: chunk.patch.replace.by });
          // 不 continue：yield 出去让 streamAgentChunks 转 "replaced" notification，
          // 通知 web 实时更新对应历史 sense block（而非等下次 chat.get 回放）。
        } else {
          // recovery update patch = { content, hash }，整体写入
          // （旧实现仅判 content 丢 hash → confirm pending sense hash 永远 NULL → 重启去重失效）
          fillApprovalResult(chatId, chunk.id, {
            content: chunk.patch.content,
            hash: chunk.patch.hash,
          });
          syncedIds.add(chunk.id);
          logger.event("message.updated", {
            messageId: chunk.id,
            contentLen: chunk.patch.content?.length ?? 0,
            hash: chunk.patch.hash,
          });
          continue;
        }
      }

      if (chunk.type === "sense_pending") {
        // P1-11：approvalPromise 由 core approvalRegistry 管理，service 仅按 approvalId 注册标记，
        //   confirm/abort 时 ApprovalManager 调 resolveApproval/rejectApproval 触发 core await。
        approvalManager.register(chunk.approvalId);
        logger.event("approval.pending", {
          approvalId: chunk.approvalId,
          senseName: chunk.senseName,
          supervisionLevel: chunk.supervisionLevel,
        });
        continue;
      }

      yield chunk;
    }
  } finally {
    // abort 兜底：ws.close → connectionManager.close → approvalManager.abort 解除 senseMiddleware
    // await（不调 gen.return，避免与 catch yield 死锁）。sense_call 流的 assistant 已在 sense_end
    // 时落库（for-await 内 effect）；纯 content 流的 assistant 在 checkpoint finally yield effect
    // 被 observer 消费落库。此处兜底 flush 极端情况未 sync 的消息，保证 DB 一致。
    for (const m of getMessages()) {
      // 仅落库 user/assistant/sense（system 仅内存 loadHistory 期不入库；function 本项目不产生）
      if (m.revoked) continue;
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "sense") continue;
      if (syncedIds.has(m.id)) continue;
      addMessage(m.id, chatId, {
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        senseCall: m.senseCalls,
        hash: m.hash,
      });
      syncedIds.add(m.id);
    }
  }
}
