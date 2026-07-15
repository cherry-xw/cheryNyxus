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
  type ChatDeleteResponseData,
  type ChatListRequestData,
  type ChatListResponseData,
  type ChatContextUsageRequestData,
  type ChatContextUsageResponseData,
  type ChatSyncRequestData,
  type ChatSyncResponseData,
  type ChatStartSpawnRequestData,
  type ChatStartSpawnResponseData,
  type Response as RpcResponse,
} from "../message/types.js";
import {
  createChat,
  listAllChats,
  getChat,
  deleteChat,
  getMessages,
  getLastMessage,
  parseMessageRow,
  findChatsByParent,
  getChatPreviews,
} from "@/db/chat.js";
import { clearChatRuntime, ensureChat, isChatRunning } from "./runtime.js";
import { getQuestionStateSnapshot, hasPendingQuestionBatches } from "@/db/question.js";
import { randomUUID } from "crypto";
import { parseRuntimeSelection, resolvePresetSelection, type RuntimeSelection } from "@/agent/runtimeResolver.js";
import { logger } from "@/utils/logger/index.js";
import { computeContextUsage } from "@/utils/token.js";
import { safeJsonParse } from "@/utils/json.js";
import { getChatEvents, claimSpawnTask, finishSpawnTask, listOpenSpawnTasks } from "@/db/delivery.js";
import { handleChatResume, handleChatSend } from "./send.js";

/**
 * 判定 chat 是否可 resume（末条非 revoked 消息为未完成周期）。
 * 提取共享：chat.get / chat.list 复用，避免逻辑漂移。
 *   - role=sense：pending 或 done 无后续 assistant
 *   - role/subagent：子任务结果已注入，需恢复主 loop 消费
 *   - role=user：用户消息已入库但 assistant 未响应（异常中断）
 * getLastMessage 已过滤 revoked，此处仅判角色。
 */
export function computeCanResume(chatId: string): boolean {
  // ask_user_question yield-turn：持久化批次 pending 期间禁止 resume（否则在占位 sense 上跑 LLM）。
  if (hasPendingQuestionBatches(chatId)) return false;
  const last = getLastMessage(chatId);
  if (!last) return false;
  const role = last.role;
  return role === "sense" || role === "user" || role === "role" || role === "subagent";
}

/**
 * 创建聊天（chatId 可选由前端指定）
 * 两种编制来源（T6）：
 *   - preset：从预设 leader 角色解析 brain+senseGroups+mcp+systemPrompt（编制快照入 metadata，
 *     运行后锁定）。AgentDialog 选预设路径。
 *   - 显式 brain + senseGroups：原路径（default 兜底 / 子 agent）。
 * 任一来源均原子配置 runtime + 一次性加载历史，返回 chatId。之后 chat.send 无需再带 brain/sense。
 */
export async function handleChatCreate(
  _ctx: HandlerContext,
  data: ChatCreateRequestData,
): Promise<ChatCreateResponseData> {
  const p = data;
  const chatId = p.chatId || randomUUID();

  let selection: RuntimeSelection;
  const metadata: Record<string, unknown> = {};
  if (p.preset) {
    // 预设路径：解析编制快照 + 记 preset 名 + spawn roster（选中子 agent type 列表）+ prompt 路径
    const resolved = resolvePresetSelection(p.preset);
    selection = resolved.selection;
    metadata.preset = p.preset;
    metadata.spawnTypes = resolved.spawnTypes;
    if (resolved.promptPathOverride) metadata.promptPathOverride = resolved.promptPathOverride;
    if (resolved.workspace) metadata.workspace = resolved.workspace;
  } else {
    // 显式路径：parseRuntimeSelection 校验 brain + senseGroups 必填
    selection = parseRuntimeSelection(p, "chat.create");
  }

  createChat(chatId, Object.keys(metadata).length > 0 ? metadata : undefined, p.parentChatId);
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
    preset: p.preset,
    brain: selection.brain,
    senseGroup: selection.senseGroup,
    mcpServers: selection.mcpServers,
  });
  return {
    chatId,
    brain: selection.brain,
    senseGroup: selection.senseGroup,
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
    const meta = chat.metadata
      ? (safeJsonParse(chat.metadata, {}) as { finished?: boolean; wait?: boolean; resumePending?: boolean; preset?: string })
      : {};
    const finished = meta.finished === true;
    const running = isChatRunning(chat.id);
    // T9.10：wait（子 metadata.wait=true）供前端重连识别 wait-子（续跑 interrupted wait-子 + 唤主链重建）
    const wait = meta.wait === true;
    const resumePending = meta.resumePending === true;
    // canResume：idle 主 chat 末条为未完成周期 → 前端重建时可自动 resume（覆盖 resumePending 丢失场景）
    // 仅非 finished 非 running 时计算（finished 不可恢复，running 不需恢复）
    const canResume = !finished && !running ? computeCanResume(chat.id) : false;
    const base = {
      chatId: chat.id,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      messageCount: chat.message_count,
      parentChatId: chat.parent_chat_id ?? null,
      finished,
      running,
      wait,
      resumePending,
      canResume,
      preset: typeof meta.preset === "string" ? meta.preset : undefined,
    };
    if (!data.includePreview || !previews) return base;
    const p = previews.get(chat.id);
    const detail = computeContextUsage(chat.id);
    return { ...base, preview: p?.preview ?? "", turnCount: p?.turnCount ?? 0, contextUsage: detail.usage, contextUsed: detail.used, contextTotal: detail.total };
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
  ctx: HandlerContext,
  data: ChatGetRequestData,
): AsyncGenerator<Chunk | Notification, ChatGetResponseData, unknown> {
  const p = data;
  const requestId = ctx.requestId ?? p.chatId;

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
      yield createChunk("staged", requestId, {
        type: "thinking_end",
        role: parsedMsg.role,
        thinking: parsedMsg.thinking,
        createdAt: msg.created_at,
        msgId: msg.id,
        agentChatId: p.chatId,
      }, { chatId: p.chatId });
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
      yield createChunk("staged", requestId, {
        type: "content_end",
        role: parsedMsg.role,
        content: parsedMsg.content,
        createdAt: msg.created_at,
        msgId: msg.id,
        agentChatId: p.chatId,
        ...(msgRuntime ? { runtime: msgRuntime } : {}),
        // role:sense 的 content 是 sense 执行结果，带 id（= sense call id）供前端关联到 sense block
        ...(parsedMsg.role === "sense" ? { id: msg.id } : {}),
        // 感官去重命中：附加 replace 元数据（content 仍为原内容，前端据此渲染"已过时"）
        ...(parsedMsg.replace?.state
          ? { replace: parsedMsg.replace, originalContent: parsedMsg.originalContent }
          : {}),
      }, { chatId: p.chatId });
    }
    // 仅 assistant 消息携带 senseCalls（sense 消息的 senseCalls 是冗余副本，跳过避免历史回放重复）
    if (parsedMsg.role !== "sense" && parsedMsg.senseCall && parsedMsg.senseCall.length > 0) {
      for (const sc of parsedMsg.senseCall) {
        yield createChunk("staged", requestId, {
          type: "sense_end",
          role: parsedMsg.role,
          senseName: sc.name,
          arguments: sc.arguments,
          id: sc.id,
          agentChatId: p.chatId,
        }, { chatId: p.chatId });
      }
    }
  }

  // 发送 loaded notification
  yield createNotification("loaded", requestId, null, { chatId: p.chatId });

  // CP7：contextUsage = 当前 chat 总 token / brain.contextLimit，供前端 ContextBar 渲染。
  // 历史载入后计算一次（前端 chat.get response 同步带值），发消息时由 done notification 实时更新。
  const ctxDetail = computeContextUsage(p.chatId);

  // 复用共享判定（同 chat.list）
  const canResume = computeCanResume(p.chatId);

  const questionSnapshot = getQuestionStateSnapshot(p.chatId);
  logger.event("chat.get", {
    chatId: p.chatId,
    messageCount: messages.length,
    canResume,
    contextUsage: ctxDetail.usage,
    pendingQuestionBatches: questionSnapshot.pendingQuestionBatches.length,
    snapshotSeq: questionSnapshot.snapshotSeq,
  });
  return {
    chatId: p.chatId,
    canResume,
    contextUsage: ctxDetail.usage,
    contextUsed: ctxDetail.used,
    contextTotal: ctxDetail.total,
    ...questionSnapshot,
  };
}

/**
 * Replays the recoverable event stream for a chat. When retention has evicted
 * the requested cursor, callers receive reset=true and reload chat.get.
 * Open role tasks are emitted in that fallback so their start intent survives
 * even when the original role_created event has expired.
 */
export async function* handleChatSync(
  _ctx: HandlerContext,
  data: ChatSyncRequestData,
): AsyncGenerator<Chunk | Notification, ChatSyncResponseData, unknown> {
  if (!getChat(data.chatId)) throw new Error(`Chat "${data.chatId}" not found`);
  const page = getChatEvents(data.chatId, data.afterSeq);
  if (page.reset) {
    for (const task of listOpenSpawnTasks(data.chatId)) {
      yield createNotification("role_created", undefined, {
        taskId: task.taskId,
        chatId: task.childChatId,
        parentChatId: task.parentChatId,
        type: task.type,
        prompt: task.prompt,
        brain: task.brain,
        senseGroup: task.senseGroup,
        wait: task.wait,
      }, { chatId: data.chatId });
    }
  } else {
    for (const event of page.events) {
      yield event as unknown as Chunk | Notification;
    }
  }
  const questionSnapshot = getQuestionStateSnapshot(data.chatId);
  return {
    chatId: data.chatId,
    latestSeq: page.latestSeq,
    ...(page.minSeq !== undefined ? { minSeq: page.minSeq } : {}),
    reset: page.reset,
    ...questionSnapshot,
  };
}

/**
 * Atomically starts the prompt attached to a persisted role task. Replayed
 * role_created events can call this endpoint repeatedly: only the winning
 * pending→started transition sends the initial user prompt.
 */
export async function* handleChatStartSpawn(
  ctx: HandlerContext,
  data: ChatStartSpawnRequestData,
): AsyncGenerator<Chunk | Notification, ChatStartSpawnResponseData | RpcResponse, unknown> {
  const claimed = claimSpawnTask(data.taskId);
  const task = claimed.task;
  if (!task) throw new Error(`Spawn task "${data.taskId}" not found`);
  if (task.status === "finished") {
    return { chatId: task.childChatId, runId: ctx.requestId ?? data.taskId, alreadyFinished: true };
  }

  if (claimed.firstStart) {
    const result = yield* handleChatSend(ctx, { chatId: task.childChatId, prompt: task.prompt });
    // A yielded child can end this RPC without producing its own assistant
    // message (for example, while waiting on a descendant). Keep the task
    // `started` in that case so a reconnect can resume the persisted prompt;
    // only an actual child terminal message makes the launch irrecoverable.
    if (!("success" in result) || result.success !== false) {
      const last = getLastMessage(task.childChatId);
      if (last?.role === "assistant") finishSpawnTask(task.taskId);
    }
    return result;
  }

  // A previous launcher may still be streaming. handleChatResume returns
  // alreadyRunning in that case, otherwise it continues an interrupted child
  // from its persisted user message without inserting that message again.
  const last = getLastMessage(task.childChatId);
  if (last?.role === "assistant") {
    finishSpawnTask(task.taskId);
    return { chatId: task.childChatId, runId: ctx.requestId ?? data.taskId, alreadyFinished: true };
  }
  const result = yield* handleChatResume(ctx, { chatId: task.childChatId });
  if (!("success" in result) || result.success !== false) {
    const finalLast = getLastMessage(task.childChatId);
    if (finalLast?.role === "assistant") finishSpawnTask(task.taskId);
  }
  return result;
}

/**
 * 删除聊天
 * CP8：目标为主 chat（无 parent_chat_id）时级联删其全部后代 chat + 各自消息 + 清内存 runtime，
 *   避免多级 spawn 留下孤儿 chat。子 chat 自身删除不级联。
 */
export async function handleChatDelete(
  _ctx: HandlerContext,
  data: ChatDeleteRequestData,
): Promise<ChatDeleteResponseData> {
  const p = data;

  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  // 主 chat 级联全部后代：后序删除保证孙级先于父级，容忍异常 parent 环。
  const isMaster = !chat.parent_chat_id;
  let cascaded = 0;
  if (isMaster) {
    const descendants: Array<{ id: string }> = [];
    const seen = new Set<string>([p.chatId]);
    const visit = (parentChatId: string): void => {
      for (const child of findChatsByParent(parentChatId)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        visit(child.id);
        descendants.push(child);
      }
    };
    visit(p.chatId);
    cascaded = descendants.length;
    for (const child of descendants) {
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
 * chat.contextUsage：轻量取上下文用量详情（不流式回历史）。
 * 前端 initFromChats 后为每个可见 pet 拉一次，驱动 ContextBar 初始渲染。
 */
export async function handleChatContextUsage(
  _ctx: HandlerContext,
  data: ChatContextUsageRequestData,
): Promise<ChatContextUsageResponseData> {
  const detail = computeContextUsage(data.chatId);
  return { chatId: data.chatId, contextUsage: detail.usage, contextUsed: detail.used, contextTotal: detail.total };
}

/**
 * 注册 Chat 管理 handlers
 */
export function registerChatManageHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_CREATE, handleChatCreate);
  router.register(Method.CHAT_LIST, handleChatList);
  router.register(Method.CHAT_GET, handleChatGet);  // 流式返回历史
  router.register(Method.CHAT_SYNC, handleChatSync);
  router.register(Method.CHAT_START_SPAWN, handleChatStartSpawn);
  router.register(Method.CHAT_DELETE, handleChatDelete);
  router.register(Method.CHAT_CONTEXT_USAGE, handleChatContextUsage);
}
