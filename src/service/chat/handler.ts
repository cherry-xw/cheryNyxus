import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createNotification,
  Method,
  type Chunk,
  type Notification,
  type ChatCreateRequestData,
  type ChatCreateResponseData,
  type ChatListRequestData,
  type ChatGetRequestData,
  type ChatGetResponseData,
  type ChatDeleteRequestData,
} from "../message/types.js";
import {
  createChat,
  listChatsBySoul,
  getChat,
  deleteChat,
  getMessages,
  parseMessageRow,
  addMessage,
  fillApprovalResult,
} from "@/db/chat.js";
import { ensureSoul, streamAgentChunks } from "./send.js";
import type { PersistMessageData } from "@/core/middleware/types";
import { getSoul } from "@/db/soul.js";
import { clearChatFromMemory } from "../soul/lifecycle.js";
import { randomUUID } from "crypto";

/**
 * 创建聊天
 */
export async function handleChatCreate(
  ctx: HandlerContext,
  params: unknown,
): Promise<ChatCreateResponseData> {
  const p = params as ChatCreateRequestData;

  // 校验 soul 存在
  const soul = getSoul(p.soulId);
  if (!soul) {
    throw new Error(`Soul "${p.soulId}" not found`);
  }

  const chatId = randomUUID();
  createChat(chatId, p.soulId);

  return { chatId };
}

/**
 * 列出聊天
 */
export async function handleChatList(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as ChatListRequestData;

  const chats = listChatsBySoul(p.soulId).map(chat => {
    const messages = getMessages(chat.id);
    return {
      chatId: chat.id,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      messageCount: messages.length,
    };
  });

  return { chats };
}

/**
 * 获取聊天详情（载入历史对话）
 */
export async function* handleChatGet(
  ctx: HandlerContext,
  params: unknown,
): AsyncGenerator<Chunk | Notification, ChatGetResponseData, unknown> {
  const p = params as ChatGetRequestData;

  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  const messages = getMessages(p.chatId);

  // 逐条返回历史消息（和初期对话一致，但没有 delta）
  for (const msg of messages) {
    const parsedMsg = parseMessageRow(msg);

    if (parsedMsg.thinking) {
      yield createChunk("staged", p.chatId, { type: "thinking_end", role: parsedMsg.role, thinking: parsedMsg.thinking });
    }
    if (parsedMsg.content) {
      yield createChunk("staged", p.chatId, { type: "content_end", role: parsedMsg.role, content: parsedMsg.content });
    }
    if (parsedMsg.senseCall && parsedMsg.senseCall.length > 0) {
      for (const sc of parsedMsg.senseCall) {
        yield createChunk("staged", p.chatId, {
          type: "sense_end",
          role: parsedMsg.role,
          senseName: sc.name,
          arguments: sc.arguments,
        });
      }
    }
  }

  // Phase 4: Recovery — 加载 agent → resume → 流式输出
  // senseMiddleware Phase 0 自动检测 pending senses → 处理 → LLM 继续
  const rid = p.chatId;
  const soul = await ensureSoul(chat.soul_id);
  const agent = await soul.agent;

  agent.createChat(p.chatId);
  const middlewareCtx = agent.getContext(p.chatId);

  if (middlewareCtx) {
    // 注入消息持久化回调
    middlewareCtx.persistMessage = (msg: PersistMessageData) => {
      addMessage(msg.id, p.chatId, {
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking,
        senseCall: msg.senseCalls,
      });
    };

    // 注入消息更新回调（recovery 场景：UPDATE 已有记录）
    middlewareCtx.updateMessage = (id: string, content: string) => {
      fillApprovalResult(id, content);
    };

    // 从数据库加载历史消息到 context（供 Phase 0 检测和 LLM 使用）
    const historyRows = getMessages(p.chatId);
    const messages = middlewareCtx.soul.messages ?? [];
    for (const row of historyRows) {
      const parsed = parseMessageRow(row);
      messages.push({
        id: row.id,
        role: parsed.role,
        content: parsed.content ?? "",
        thinking: parsed.thinking,
        senseCalls: parsed.senseCall,
        createdAt: row.created_at,
        updateAt: row.created_at,
      });
    }
    middlewareCtx.soul.messages = messages;
    middlewareCtx.soul.historyLoaded = true;

    // 检测是否有 pending sense（role=sense, content 为空）
    const hasPendingSense = messages.some(
      m => m.role === "sense" && (!m.content || m.content.trim() === "")
    );

    // 仅有 pending sense 时才 resume（无 pending 时不应调用 LLM）
    if (hasPendingSense) {
      // 计算 loop 起始计数（最后 user 消息后的 assistant 消息数）
      const lastUserIdx = messages.findLastIndex(m => m.role === "user");
      middlewareCtx.soul.loopStartCount = lastUserIdx >= 0
        ? messages.slice(lastUserIdx + 1).filter(m => m.role === "assistant").length
        : 0;

      // resume → senseMiddleware Phase 0 自动检测 pending → 处理 → LLM → loop
      const generator = agent.resume(p.chatId);
      yield* streamAgentChunks(generator, rid);
    }
  }

  // 发送 loaded notification
  yield createNotification("loaded", p.chatId, null);

  return { chatId: p.chatId };
}

/**
 * 删除聊天
 */
export async function handleChatDelete(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as ChatDeleteRequestData;

  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  // 清理内存 chatMap（防止删除后重建时数据不一致）
  await clearChatFromMemory(chat.soul_id, p.chatId);

  // 删除数据库记录
  deleteChat(p.chatId);

  return { chatId: p.chatId };
}

/**
 * 注册 Chat 管理 handlers
 */
export function registerChatManageHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_CREATE, handleChatCreate);
  router.register(Method.CHAT_LIST, handleChatList);
  router.register(Method.CHAT_GET, handleChatGet, true);  // 流式返回历史
  router.register(Method.CHAT_DELETE, handleChatDelete);
}
