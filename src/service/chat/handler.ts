import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createNotification,
  Method,
  type Chunk,
  type Notification,
  type ChatCreateRequestData,
  type ChatCreateResponseData,
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
import { parseRuntimeSelection } from "@/agent/runtimeResolver.js";
import { logger } from "@/utils/logger/index.js";

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
  const selection = parseRuntimeSelection(p, "chat.create");
  const chatId = p.chatId || randomUUID();
  createChat(chatId);
  // 原子配置 runtime，并一次性加载历史到 agent。
  await ensureChat(chatId, selection);
  logger.event("chat.create", {
    chatId,
    brain: p.brain,
    senseGroups: p.senseGroups,
  });
  return { chatId };
}

/**
 * 列出所有聊天（全局）
 */
export async function handleChatList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<unknown> {
  // P1-8：messageCount 读冗余 message_count 列，消除 chatList N+1 查询
  const chats = listAllChats().map(chat => ({
    chatId: chat.id,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    messageCount: chat.message_count,
  }));

  logger.event("chat.list", { count: chats.length });
  return { chats };
}

/**
 * 获取聊天详情（载入历史对话）
 * runtime selection 持久化在 chats.metadata.runtime，服务重启后 ensureChat 自动恢复，
 * 前端无需重新 runtime.set（除非持久化的 brain/group 已从 config.yaml 删除，恢复时报错）。
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
      yield createChunk("staged", p.chatId, {
        type: "content_end",
        role: parsedMsg.role,
        content: parsedMsg.content,
        // role:sense 的 content 是 sense 执行结果，带 id（= sense call id）供前端关联到 sense block
        ...(parsedMsg.role === "sense" ? { id: msg.id } : {}),
        // 感官去重命中：附加 replace 元数据（content 仍为原内容，前端据此渲染"已过时"）
        ...(parsedMsg.replace?.state
          ? { replace: parsedMsg.replace, originalContent: parsedMsg.originalContent }
          : {}),
      });
    }
    if (parsedMsg.senseCall && parsedMsg.senseCall.length > 0) {
      for (const sc of parsedMsg.senseCall) {
        yield createChunk("staged", p.chatId, {
          type: "sense_end",
          role: parsedMsg.role,
          senseName: sc.name,
          arguments: sc.arguments,
          id: sc.id,
        });
      }
    }
  }

  // 发送 loaded notification
  yield createNotification("loaded", p.chatId, null);

  // 末条（跳过已撤回 revoked）为未完成周期 → canResume
  //   - role=sense：pending 或 done 无后续 assistant（pending sense 待恢复执行 / 继续 loop）
  //   - role=user：用户消息已入库但 assistant 未响应（异常中断，如服务崩溃），resume Case2 复用末条 user 调 LLM
  const lastVisible = [...messages].reverse().find(m => !m.revoked);
  const canResume = !!lastVisible && (lastVisible.role === "sense" || lastVisible.role === "user");

  logger.event("chat.get", { chatId: p.chatId, messageCount: messages.length, canResume });
  return { chatId: p.chatId, canResume };
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

  logger.event("chat.delete", { chatId: p.chatId });
  return { chatId: p.chatId };
}

/**
 * 注册 Chat 管理 handlers
 */
export function registerChatManageHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_CREATE, handleChatCreate);
  router.register(Method.CHAT_LIST, handleChatList);
  router.register(Method.CHAT_GET, handleChatGet);  // 流式返回历史
  router.register(Method.CHAT_DELETE, handleChatDelete);
}
