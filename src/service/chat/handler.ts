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
  type ChatListRequestData,
  type ChatListResponseData,
} from "../message/types.js";
import {
  createChat,
  listAllChats,
  getChat,
  deleteChat,
  getMessages,
  parseMessageRow,
  findChatsByParent,
  getChatPreviews,
} from "@/db/chat.js";
import { clearChatRuntime, ensureChat, isChatRunning } from "./runtime.js";
import { randomUUID } from "crypto";
import { parseRuntimeSelection, type RuntimeSelection } from "@/agent/runtimeResolver.js";
import { logger } from "@/utils/logger/index.js";
import { computeContextUsage } from "@/utils/token.js";
import { safeJsonParse } from "@/utils/json.js";

/**
 * 创建聊天（chatId 可选由前端指定）
 * 必携带 brain + senseGroups：创建 agent runtime、注册事件任务并加载历史，
 * 返回 chatId。之后 chat.send 无需再带 brain/sense。
 */
export async function handleChatCreate(
  _ctx: HandlerContext,
  data: ChatCreateRequestData,
): Promise<ChatCreateResponseData> {
  const p = data;
  const selection = parseRuntimeSelection(p, "chat.create");
  const chatId = p.chatId || randomUUID();
  createChat(chatId, undefined, p.parentChatId);
  try {
    // 原子配置 runtime，并一次性加载历史到 agent。
    await ensureChat(chatId, selection);
  } catch (err) {
    // ensureChat 失败（configureRuntime 深校验/init 抛错）：清 runtime map 项 + 删 createChat 刚插入的 DB 行，
    // 避免孤儿 chat 行 + 半配置 runtime。createChat 严格 INSERT（重复 chatId 提前抛 SQLITE_CONSTRAINT），
    // 故此 catch 仅在本次新建行后触发，deleteChat 安全（不会销毁既有 chat）。
    clearChatRuntime(chatId);
    deleteChat(chatId);
    throw err;
  }
  logger.event("chat.create", {
    chatId,
    brain: selection.brain,
    senseGroups: selection.senseGroups,
    mcpServers: selection.mcpServers,
  });
  return {
    chatId,
    brain: selection.brain,
    senseGroups: selection.senseGroups,
    mcpServers: selection.mcpServers,
  };
}

/**
 * 列出所有聊天（全局）
 * CP8：includePreview=true 时每项增返 preview（首条 user 消息截断）+ turnCount（user 消息数），
 *   按 messages_month 分组批量查，供会话列表渲染；省略=lean，供初始化重建 pet 树（免 N+1）。
 */
export async function handleChatList(
  _ctx: HandlerContext,
  data: ChatListRequestData,
): Promise<ChatListResponseData> {
  const rows = listAllChats();
  const previews = data.includePreview ? getChatPreviews(rows) : undefined;

  const chats = rows.map(chat => {
    const finished = chat.metadata
      ? (safeJsonParse(chat.metadata, {}) as { finished?: boolean }).finished === true
      : false;
    const running = isChatRunning(chat.id);
    const base = {
      chatId: chat.id,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      messageCount: chat.message_count,
      parentChatId: chat.parent_chat_id ?? null,
      finished,
      running,
    };
    if (!data.includePreview || !previews) return base;
    const p = previews.get(chat.id);
    return { ...base, preview: p?.preview ?? "", turnCount: p?.turnCount ?? 0 };
  });

  logger.event("chat.list", { count: chats.length, includePreview: !!data.includePreview });
  return { chats };
}

/**
 * 获取聊天详情（载入历史对话）
 * runtime selection 持久化在 chats.metadata.runtime，服务重启后 ensureChat 自动恢复，
 * 前端无需重新 runtime.set（除非持久化的 brain/group 已从 config.yaml 删除，恢复时报错）。
 */
export async function* handleChatGet(
  _ctx: HandlerContext,
  data: ChatGetRequestData,
): AsyncGenerator<Chunk | Notification, ChatGetResponseData, unknown> {
  const p = data;

  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  const messages = getMessages(p.chatId);

  // 消息级 runtime 溯源：user 消息带自身 runtime，assistant 带前一条 user runtime（关联，见 agent-pet.md §5.7）
  let lastUserRuntime: RuntimeSelection | undefined;

  // 逐条返回历史消息
  for (const msg of messages) {
    const parsedMsg = parseMessageRow(msg);

    if (parsedMsg.thinking) {
      yield createChunk("staged", p.chatId, {
        type: "thinking_end",
        role: parsedMsg.role,
        thinking: parsedMsg.thinking,
        createdAt: msg.created_at,
      });
    }
    if (parsedMsg.content) {
      // runtime 关联：user=自身 runtime（并更新 lastUserRuntime），assistant=前一条 user runtime
      let msgRuntime: RuntimeSelection | undefined;
      if (parsedMsg.role === "user") {
        msgRuntime = parsedMsg.runtime;
        lastUserRuntime = msgRuntime;
      } else if (parsedMsg.role === "assistant") {
        msgRuntime = lastUserRuntime;
      }
      yield createChunk("staged", p.chatId, {
        type: "content_end",
        role: parsedMsg.role,
        content: parsedMsg.content,
        createdAt: msg.created_at,
        ...(msgRuntime ? { runtime: msgRuntime } : {}),
        // role:sense 的 content 是 sense 执行结果，带 id（= sense call id）供前端关联到 sense block
        ...(parsedMsg.role === "sense" ? { id: msg.id } : {}),
        // 感官去重命中：附加 replace 元数据（content 仍为原内容，前端据此渲染"已过时"）
        ...(parsedMsg.replace?.state
          ? { replace: parsedMsg.replace, originalContent: parsedMsg.originalContent }
          : {}),
      });
    }
    // 仅 assistant 消息携带 senseCalls（sense 消息的 senseCalls 是冗余副本，跳过避免历史回放重复）
    if (parsedMsg.role !== "sense" && parsedMsg.senseCall && parsedMsg.senseCall.length > 0) {
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

  // CP7：contextUsage = 当前 chat 总 token / brain.contextLimit，供前端 ContextBar 渲染。
  // 历史载入后计算一次（前端 chat.get response 同步带值），发消息时由 done notification 实时更新。
  const contextUsage = computeContextUsage(p.chatId);

  // 末条（跳过已撤回 revoked）为未完成周期 → canResume
  //   - role=sense：pending 或 done 无后续 assistant（pending sense 待恢复执行 / 继续 loop）
  //   - role=user：用户消息已入库但 assistant 未响应（异常中断，如服务崩溃），resume Case2 复用末条 user 调 LLM
  const lastVisible = [...messages].reverse().find(m => !m.revoked);
  const canResume = !!lastVisible && (lastVisible.role === "sense" || lastVisible.role === "user");

  logger.event("chat.get", { chatId: p.chatId, messageCount: messages.length, canResume, contextUsage });
  return { chatId: p.chatId, canResume, contextUsage };
}

/**
 * 删除聊天
 * CP8：目标为主 chat（无 parent_chat_id）时级联删其所有子 chat + 各自消息 + 清内存 runtime，
 *   避免孤儿子 chat 残留 DB。子 chat 自身删除不级联。
 */
export async function handleChatDelete(
  _ctx: HandlerContext,
  data: ChatDeleteRequestData,
): Promise<unknown> {
  const p = data;

  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  // 主 chat 级联子 chat：先删子（messages + chat 行 + runtime），再删主
  const isMaster = !chat.parent_chat_id;
  let cascaded = 0;
  if (isMaster) {
    const children = findChatsByParent(p.chatId);
    cascaded = children.length;
    for (const child of children) {
      clearChatRuntime(child.id);
      deleteChat(child.id);
    }
  }

  // 清理运行时缓存 + 删除目标 chat
  clearChatRuntime(p.chatId);
  deleteChat(p.chatId);

  logger.event("chat.delete", { chatId: p.chatId, cascaded });
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
