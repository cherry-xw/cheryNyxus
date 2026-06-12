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
  listAllChats,
  getChat,
  deleteChat,
  getMessages,
  parseMessageRow,
} from "@/db/chat.js";
import { clearChatRuntime, ensureChat } from "./send.js";
import { randomUUID } from "crypto";
import type { RuntimeSelection } from "@/agent/runtimeResolver.js";

function parseRuntimeSelection(params: ChatCreateRequestData): RuntimeSelection {
  if (!params.brain || !Array.isArray(params.senseGroups) || params.senseGroups.length === 0) {
    throw new Error("chat.create requires brain and at least one senseGroups entry");
  }
  return {
    brain: params.brain,
    senseGroups: params.senseGroups,
  };
}

/**
 * 创建聊天（chatId 可选由前端指定）
 * 必携带 brain + senseGroups：创建 agent runtime、注册事件任务并加载历史，
 * 返回 chatId。之后 chat.send 无需再带 brain/sense。
 */
export async function handleChatCreate(
  _ctx: HandlerContext,
  params: unknown,
): Promise<ChatCreateResponseData> {
  const p = params as ChatCreateRequestData;
  const selection = parseRuntimeSelection(p);
  const chatId = p.chatId || randomUUID();
  createChat(chatId);
  // 原子配置 runtime，并一次性加载历史到 agent。
  await ensureChat(chatId, selection);
  return { chatId };
}

/**
 * 列出所有聊天（全局）
 */
export async function handleChatList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<unknown> {
  const chats = listAllChats().map(chat => {
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
 * 重构后不再做 pending sense recovery（brain/sense 运行时不持久化），
 * 仅流式返回历史消息，前端通过 runtime.set 重新注入 runtime 后即可继续。
 */
export async function* handleChatGet(
  _ctx: HandlerContext,
  params: unknown,
): AsyncGenerator<Chunk | Notification, ChatGetResponseData, unknown> {
  const p = params as ChatGetRequestData;

  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  const messages = getMessages(p.chatId);

  // 逐条返回历史消息
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

  // 发送 loaded notification
  yield createNotification("loaded", p.chatId, null);

  return { chatId: p.chatId };
}

/**
 * 删除聊天
 */
export async function handleChatDelete(
  _ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as ChatDeleteRequestData;

  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  // 清理运行时缓存
  clearChatRuntime(p.chatId);

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
