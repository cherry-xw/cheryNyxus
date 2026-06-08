import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createNotification,
  Method,
  type Chunk,
  type Notification,
  type ChatListRequestData,
  type ChatGetRequestData,
  type ChatGetResponseData,
  type ChatDeleteRequestData,
} from "../message/types.js";
import {
  listChatsBySoul,
  getChat,
  deleteChat,
  getMessages,
  parseMessageRow,
} from "@/db/chat.js";

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
      yield createChunk("staged", p.chatId, { type: "thinking_end", thinking: parsedMsg.thinking });
    }
    if (parsedMsg.content) {
      yield createChunk("staged", p.chatId, { type: "content_end", content: parsedMsg.content });
    }
    if (parsedMsg.senseCall && parsedMsg.senseCall.length > 0) {
      for (const sc of parsedMsg.senseCall) {
        yield createChunk("staged", p.chatId, {
          type: "sense_end",
          senseName: sc.name,
          arguments: sc.arguments,
        });
      }
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

  deleteChat(p.chatId);

  return { chatId: p.chatId };
}

/**
 * 注册 Chat 管理 handlers
 */
export function registerChatManageHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_LIST, handleChatList);
  router.register(Method.CHAT_GET, handleChatGet, true);  // 流式返回历史
  router.register(Method.CHAT_DELETE, handleChatDelete);
}
