import { addMessage, fillApprovalResult, markMessageReplaced, updateAssistantSenseCalls, updateChatMetadata } from "@/db/chat.js";
import { getChatSelection } from "./runtime.js";
import { approvalManager } from "../approval/manager.js";

import { wakeParent } from "./wake.js";
import type { LLMResponse } from "@/core/message/adapter";
import type { MiddlewareChunk } from "@/core/middleware/types";
import { logger } from "@/utils/logger/index.js";
import { getWaitedParent } from "@/agent/spawnBroker.js";
import { createQuestionBatch } from "@/db/question.js";

/**
 * 统一消费 agent 内部 effect chunk（P2-1 从 send.ts 拆出）。
 * middleware 只产出事实流，service observer 在这里集中处理 DB/approval 副作用。
 *
 * onUserMessageCreated（可选）：user message 落库后回调（携带 msgId）。
 * send.ts 据此在 Response.data 回 userMsgId，前端 sendMessage 即时 push user prompt
 * 到 stream.history 时附带 msgId，下一次 chat.get reload 时按 msgId dedup。
 */
export async function* observeAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  chatId: string,
  getMessages: () => LLMResponse[],
  onUserMessageCreated?: (msgId: string) => void,
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
            contextCompaction: chunk.message.contextCompaction,
            contextCompactionTokens: chunk.message.contextCompactionTokens,
            // 仅 user 消息记 runtime（发送时配置）；assistant/sense 不记 NULL
            runtime: chunk.message.role === "user" ? getChatSelection(chatId) : undefined,
          });
          syncedIds.add(chunk.message.id);
          // user 消息落库后回调（send.ts 据此回 userMsgId 给前端做实时 push + msgId dedup）
          if (chunk.message.role === "user" && onUserMessageCreated) {
            onUserMessageCreated(chunk.message.id);
          }
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
        if (chunk.patch.kind === "replace") {
          // 感官去重命中：content 改说明文字 + replace 状态 + originalContent 落库
          markMessageReplaced(chatId, chunk.id, {
            content: chunk.patch.content,
            replace: chunk.patch.replace,
            originalContent: chunk.patch.originalContent,
          });
          syncedIds.add(chunk.id);
          logger.event("message.replaced.db", { messageId: chunk.id, by: chunk.patch.replace.by });
          // yield 出去让 streamAgentChunks 转 "replaced" notification，
          // 通知 web 实时更新对应历史 sense block（而非等下次 chat.get 回放）。
          yield chunk;
          continue;
        }

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

        // 流式多 sense_call reconcile：patch 仅含 senseCalls 时调 updateAssistantSenseCalls（独立 UPDATE）
        if (chunk.patch.senseCalls) {
          updateAssistantSenseCalls(chatId, chunk.id, chunk.patch.senseCalls);
          logger.event("message.updated.sense_calls", {
            messageId: chunk.id,
            senseCalls: chunk.patch.senseCalls.length,
          });
        }
        continue;
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

      if (chunk.type === "question_batch_pending") {
        // placeholder sense 已由前序 message_created effect 全部落库；先持久化批次，再允许协议事件出站。
        // 这样任何收到事件的客户端都能立即安全调用原子 batchAnswer。
        const batch = createQuestionBatch(chatId, chunk.assistantMessageId, chunk.questions);
        if (!batch) continue;
        logger.event("question.batch.pending", {
          batchId: chunk.batchId,
          assistantMessageId: chunk.assistantMessageId,
          questionCount: chunk.questions.length,
        });
        yield chunk;
        continue;
      }

      // child_yield chunk（wait=true 子 agent yield turn 本轮暂停）→ 仅记录日志，不唤醒主，不设 finished
      // 子 agent 保持活跃状态，等待孙 agent 完成后 resume 继续运行
      if (chunk.type === "child_yield") {
        logger.event("child.yield", {
          childChatId: chunk.childChatId,
          contentLen: chunk.content.length,
        });
        continue;
      }

      // child_done chunk（wait=true 子 loop 真正完成）→ wakeParent 注入角色回复唤主 + 设 finished
      if (chunk.type === "child_done") {
        const waited = getWaitedParent(chunk.childChatId);
        if (waited) {
          // wakeParent 内部 clearWaitedChild + 注入 role:role 回复（内存+DB）+ 推 role_reply
          await wakeParent(waited.parentChatId, chunk.childChatId, waited.type, chunk.content);

          // 设置 finished 标记（子 agent 真正完成，前端据此变 ghost）
          updateChatMetadata(chunk.childChatId, { finished: true });

          logger.event("child.done.wake", { childChatId: chunk.childChatId, parentChatId: waited.parentChatId, contentLen: chunk.content.length });
        }
        continue;
      }

      yield chunk;
    }
  } catch (err) {
    // 角色出错（含 abort）：若被 wait，注入错误回复唤主（不等 5min 看门狗，防主卡死）。
    // child_done 正常完成路径不触发此处（throw 跳过 loop 末尾 child_done yield）；wakeParent 内部 clearWaitedChild 防并发。
    const waited = getWaitedParent(chatId);
    if (waited) {
      await wakeParent(
        waited.parentChatId,
        chatId,
        waited.type,
        `[${waited.type}] 执行出错了: ${(err as Error).message}`,
      );
    }
    throw err;
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
        contextCompaction: m.contextCompaction,
        contextCompactionTokens: m.contextCompactionTokens,
        // 仅 user 消息记 runtime（发送时配置）
        runtime: m.role === "user" ? getChatSelection(chatId) : undefined,
      });
      syncedIds.add(m.id);
    }
  }
}
