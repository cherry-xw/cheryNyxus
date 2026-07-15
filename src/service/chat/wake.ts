import { addMessage, updateChatMetadata, getChat, listAllChats, getMessages, parseMessageRow } from "@/db/chat.js";
import { safeJsonParse } from "@/utils/json.js";
import { ensureChat, abortChatRuntime } from "./runtime.js";
import { connectionManager } from "../websocket/connection.js";
import { transport } from "../websocket/transport.js";
import { createNotification } from "../message/types.js";
import { clearWaitedChild, registerWaitedChild } from "@/agent/spawnBroker.js";
import { logger } from "@/utils/logger/index.js";
import { appendChatEvent } from "@/db/delivery.js";

/**
 * wait=true 唤醒（T9 B1 架构，见 docs/agent-pet.md §5.4）。
 *
 * wakeParent：子完成 / 出错 / 看门狗超时 → 注入角色回复到主 chat（内存+DB 双写）
 * + 推 role_reply notification → 前端 chat.resume 续跑主新一轮。
 *
 * 分层：本模块（service 层）拥 DB（addMessage/updateChatMetadata）+ runtime（ensureChat/abort）+
 * ws 推送（findOwnerWsByChatId）；spawnBroker（agent 层）只持唤醒态数据，经 clearWaitedChild 释放。
 *
 * 幂等：先 clearWaitedChild（防 child_done 与看门狗超时并发重复唤同一子）。
 * 前端离线（无 owner ws）：回复已落 DB，并在主 chat metadata 记 resumePending，重连后前端可恢复主循环。
 */
export async function wakeParent(
  parentChatId: string,
  childChatId: string,
  type: string,
  content: string,
): Promise<void> {
  // 主 chat 已删除（用户删会话）→ 无处唤醒，仅清理（子结果丢弃）
  if (!getChat(parentChatId)) {
    clearWaitedChild(childChatId);
    updateChatMetadata(childChatId, { wait: false });
    logger.event("wake.parent-gone", { parentChatId, childChatId });
    return;
  }

  // 注入角色回复到主 chat：内存（journal，守单一写者）+ DB（addMessage，主 observer 未运行不经 effect）
  const builder = await ensureChat(parentChatId);
  const parentWasRunning = builder.isRunning();
  const msgId = builder.appendRoleReply(content);
  addMessage(msgId, parentChatId, { role: "role", content });

  // 子结果持久化完成后再消费 wait 链，避免落库失败时丢失重试机会。
  clearWaitedChild(childChatId);
  updateChatMetadata(childChatId, { wait: false });
  // 父不在运行时，只有前端新建的 resume 流能把该 role 输入交给 LLM；持久化标记覆盖离线/重连。
  // 父正在运行时，loop 会检测并消费新 role，无需再安排一个额外 resume。
  if (!parentWasRunning) updateChatMetadata(parentChatId, { resumePending: true });

  // 读子 chat metadata.spawnSenseCallId（= 触发 spawn 的 sense call id）。
  let spawnSenseCallId: string | undefined;
  const childMetaRow = getChat(childChatId);
  if (childMetaRow?.metadata) {
    try {
      const parsed = JSON.parse(childMetaRow.metadata) as { spawnSenseCallId?: unknown };
      if (typeof parsed.spawnSenseCallId === "string" && parsed.spawnSenseCallId.length > 0) {
        spawnSenseCallId = parsed.spawnSenseCallId;
      }
    } catch {
      // 元数据非合法 JSON → 旧记录兼容，忽略关联锚点即可。
    }
  }
  const notif = createNotification("role_reply", undefined, {
    parentChatId,
    childChatId,
    type,
    content,
    msgId,
    spawnSenseCallId,
  }, { chatId: parentChatId });
  notif.seq = appendChatEvent(parentChatId, notif as unknown as Record<string, unknown>);

  // 推 role_reply notification（findOwnerWsByChatId：主 turn 已结束也能反查 owner 推送）
  const ws = connectionManager.findOwnerWsByChatId(parentChatId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(transport.encode(notif));
  } else {
    // 前端离线：resumePending 已持久化，重连后 rebuildSpawnWaits 会恢复主循环。
    logger.event("wake.offline", { parentChatId, childChatId, type });
  }
  logger.event("wake.parent", { parentChatId, childChatId, type, contentLen: content.length });
}

/**
 * 看门狗超时回调（service 启动期 setAsyncWakeHandler 注入）。
 * 子 5min 无完成/错误信号 → 注入超时回复唤主 + abort 子（规则12 fail loud，释放挂死资源）。
 */
export function handleAsyncWakeTimeout(child: {
  childChatId: string;
  parentChatId: string;
  type: string;
}): void {
  // wakeParent 内部 clearWaitedChild（含看门狗清理）；abort 子释放挂死的 generator
  void wakeParent(
    child.parentChatId,
    child.childChatId,
    child.type,
    `[角色 ${child.type}] 执行超时（看门狗 5min）`,
  );
  abortChatRuntime(child.childChatId);
}

/**
 * 后端启动重建 wait=true 唤醒链（T9.10 重启容错，见 docs/agent-pet.md §5.8）。
 * 扫子 chat metadata.wait===true：
 * - finished=true（子完成、崩溃前未唤主）→ wakeParent 从 DB 末条 assistant content 补唤主。
 * - finished!==true（interrupted，turn 中断）→ registerWaitedChild 重建链+看门狗（待前端重连续跑子，完成唤主）。
 *
 * service/index.ts 启动期调用（broadcaster / asyncWake 注入之后）。
 * 内存态 waitedChildren 重启即丢，本函数从持久化 metadata 重建，使 wait=true 跨后端重启可恢复。
 */
export async function rebuildWaitedChildren(): Promise<void> {
  const rows = listAllChats();
  for (const row of rows) {
    if (!row.parent_chat_id) continue; // 仅子 chat
    const meta = row.metadata
      ? (safeJsonParse(row.metadata, {}) as { wait?: boolean; finished?: boolean; type?: string })
      : {};
    if (meta.wait !== true) continue; // 仅 wait=true 子

    const childChatId = row.id;
    const parentChatId = row.parent_chat_id;
    const type = meta.type ?? "unknown";

    if (meta.finished === true) {
      // 子已完成、崩溃前未唤主 → 从 DB 末条 assistant content 补唤
      const msgs = getMessages(childChatId);
      let content = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const parsed = parseMessageRow(msgs[i]!);
        if (parsed.role === "assistant") {
          content = parsed.content ?? "";
          break;
        }
      }
      await wakeParent(parentChatId, childChatId, type, content || `[角色 ${type}]（无结果内容）`);
      logger.event("rebuild.wake-finished", { childChatId, parentChatId, type });
    } else {
      // interrupted → 重建唤醒链 + 看门狗（前端重连 chat.resume 续跑子，完成唤主）
      registerWaitedChild(childChatId, parentChatId, type);
      logger.event("rebuild.wait-interrupted", { childChatId, parentChatId, type });
    }
  }
}
