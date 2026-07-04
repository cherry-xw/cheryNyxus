import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createError,
  createNotification,
  createResponse,
  ErrorCode,
  Method,
  type Chunk,
  type Notification,
  type Response as RpcResponse,
  type ChatSendRequestData,
  type ChatSendResponseData,
  type ChatResumeRequestData,
  type ChatResumeResponseData,
  type SenseApprovalRequestData,
  type SenseApprovalResponseData,
  type ChatAbortRequestData,
  type ChatAbortResponseData,
} from "../message/types.js";
import { getChat, markMessagesRevoked } from "@/db/chat.js";
import { approvalManager } from "../approval/manager.js";
import { connectionManager } from "../websocket/connection.js";
import { ensureChat, clearChatRuntime, abortChatRuntime } from "./runtime.js";
import { observeAgentChunks } from "./observer.js";
import { streamAgentChunks } from "./streamMapper.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";

// P2-1：runtime 缓存/observer/streamMapper 已按职责拆出，
// re-export 保持 handler.ts 等调用方（import from "./send.js"）兼容。
export { ensureChat, clearChatRuntime, setRuntime } from "./runtime.js";

/**
 * 发送聊天消息（流式）
 * runtime 由 chat.create/runtime.set 设置，send 只携带 chatId + prompt。
 */
export async function* handleChatSend(
  ctx: HandlerContext,
  data: ChatSendRequestData,
): AsyncGenerator<Chunk | Notification, ChatSendResponseData | RpcResponse, unknown> {
  const chatId = data.chatId;

  // 校验 chat 存在
  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  logger.event("chat.send.start", {
    mode: "send",
    promptLen: data.prompt.length,
    promptPreview: data.prompt.slice(0, 200),
  });

  const agent = await ensureChat(chatId);
  const rid = ctx.requestId ?? chatId;

  // 运行中 send：仅入队（迭代触发 send body push userInputs），不绑定连接、不走流。
  // 避免空 generator（isRunning 时 send return 空 gen）立即结束而 finally 误释放当前活跃连接绑定（P0-1）。
  // 新输出跟随当前活跃流发出，客户端无需此流响应。
  if (agent.isRunning()) {
    for await (const _ of agent.run(data.prompt)) {
      /* 运行中 send 不产出 chunk，迭代仅为触发 send body 入队 */
    }
    logger.event("chat.send.queued", { promptLen: data.prompt.length });
    return { chatId };
  }

  // 绑定 chatId 到当前连接，拒绝跨连接并发 send（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId);
    logger.event("chat.bind", { chatId, connectionId: ctx.connectionId });
  } catch (e) {
    const msg = (e as Error).message;
    logger.event("chat.bind.failed", { chatId, message: msg }, LogLevel.error);
    yield createNotification("error", rid, { message: msg });
    return createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, msg));
  }

  // 恢复场景撤回：仅 idle 时触发（运行中 send 只入队，不撤回）。
  // 撤回末尾整个当前周期 AI 响应（assistant think/content/tool + 整个 sense 群），
  // 发 staged.reverse chunk 通知客户端回滚，再 run 用新 prompt 重跑。
  if (!agent.isRunning()) {
    const revokedIds = agent.revokeTrailingCycle();
    if (revokedIds.length > 0) {
      markMessagesRevoked(chatId, revokedIds);
      logger.event("chat.send.revoke", { count: revokedIds.length, messageIds: revokedIds });
      yield createChunk("staged", rid, { type: "reverse", messageIds: revokedIds });
    }
  }

  let failureResponse: RpcResponse | undefined;

  try {
    // history 已在 chat.create 时一次性加载到内存。
    // 若当前 chat 正在运行，send 只入队输入；新输出会跟随已有运行流发出。
    const generator = observeAgentChunks(agent.run(data.prompt), chatId, () => agent.getMessages());

    yield* streamAgentChunks(generator, rid);
  } catch (err) {
    const error = err as Error;
    // approval aborted（chat.abort 触发 abortChat → reject → senseMiddleware throw，
    // 见 tool.ts executeCollectedCalls catch）：chat.abort 是预期清内存操作，静默不报错。
    if (error.message === "approval aborted") {
      logger.event("chat.send.aborted", { reason: "approval aborted" });
    } else {
      logger.event("chat.send.error", { message: error.message, stack: error.stack }, LogLevel.error);
      yield createNotification("error", rid, { message: error.message });
      failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, error.message));
    }
  } finally {
    connectionManager.releaseChatConnection(chatId, ctx.connectionId);
    logger.event("chat.release", { chatId, connectionId: ctx.connectionId });
  }

  return failureResponse ?? { chatId };
}

/**
 * chat.resume — 续接（无 prompt，恢复执行 / 继续 loop）
 * 前置：chat.get 返回 canResume:true（末尾为未完成周期：pending sense 或 done sense 无后续 assistant）。
 * Case1（末尾有 pending sense）→ 置 resumePending 标志，首轮 senseMiddleware skip chat 层，
 *   从历史 pending 重建 SenseTriggerChunk 执行（按监管等级；工具不在 senseTable 写「无此工具」）；
 * Case2（末尾全 done）→ run("") 正常 loop，LLM 基于 done sense 结果回复。
 * 整体同默认 send 流一致，仅首轮跳过 chat。前置：须 chat.create / runtime.set 注入完整 runtime。
 */
export async function* handleChatResume(
  ctx: HandlerContext,
  data: ChatResumeRequestData,
): AsyncGenerator<Chunk | Notification, ChatResumeResponseData | RpcResponse, unknown> {
  const chatId = data.chatId;
  const rid = ctx.requestId ?? chatId;

  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  logger.event("chat.send.start", { mode: "resume" });

  const agent = await ensureChat(chatId);

  // 运行中 resume：无意义（无 prompt 入队，活跃流已在跑），直接返回避免重复启动流误释放绑定（P0-1）
  if (agent.isRunning()) {
    return { chatId };
  }

  // 绑定 chatId 到当前连接，拒绝跨连接并发 resume（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId);
    logger.event("chat.bind", { chatId, connectionId: ctx.connectionId });
  } catch (e) {
    const msg = (e as Error).message;
    logger.event("chat.bind.failed", { chatId, message: msg }, LogLevel.error);
    yield createNotification("error", rid, { message: msg });
    return createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, msg));
  }

  let failureResponse: RpcResponse | undefined;
  try {
    // resume 内部据末尾状态决定 Case1/Case2（见 builder.resume）
    const generator = observeAgentChunks(agent.resume(), chatId, () => agent.getMessages());
    yield* streamAgentChunks(generator, rid);
  } catch (err) {
    const error = err as Error;
    // approval aborted（chat.abort 触发，同 handleChatSend）：静默不报错
    if (error.message === "approval aborted") {
      logger.event("chat.send.aborted", { reason: "approval aborted" });
    } else {
      logger.event("chat.send.error", { message: error.message, stack: error.stack }, LogLevel.error);
      yield createNotification("error", rid, { message: error.message });
      failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, error.message));
    }
  } finally {
    connectionManager.releaseChatConnection(chatId, ctx.connectionId);
    logger.event("chat.release", { chatId, connectionId: ctx.connectionId });
  }

  return failureResponse ?? { chatId };
}

/**
 * 审批 Sense
 */
export async function handleSenseApproval(
  _ctx: HandlerContext,
  data: SenseApprovalRequestData,
): Promise<SenseApprovalResponseData> {
  // 转调 ApprovalManager.confirm → core approvalRegistry.resolve（P1-11 解耦后）
  approvalManager.confirm(data.approvalId, data.action, data.reason);
  logger.event("sense.approval", {
    approvalId: data.approvalId,
    action: data.action,
    reason: data.reason,
  });

  return {
    approvalId: data.approvalId,
    action: data.action,
  };
}

/**
 * 中止 chat（切换 chat：清内存 + 退出挂起 generator，不动 DB）。
 * 先 abortChatRuntime（compose.abort .throw 注入错误到挂起的 await → senseMiddleware catch →
 * throw 传播退出整个链，不继续 next），再 clearChatRuntime 释放该 chat 的 Middleware/messages 内存。
 * 顺序关键：clearChatRuntime 删 Map，须先取 builder 引用调 abort；throw 异步传播期间实例仍存活
 * （generator 链持有），不依赖 Map。相关数据已落 DB，此处不做任何保存；
 * pending sense content 保持 NULL，下次 chat.get canResume=true 重新审核。
 */
export async function handleChatAbort(
  _ctx: HandlerContext,
  data: ChatAbortRequestData,
): Promise<ChatAbortResponseData> {
  abortChatRuntime(data.chatId);
  // 强制解绑连接（不校验 owner）：abort 是清内存操作，跨连接重连后旧 owner 须无条件清除避免 busy 死锁（P0-2）
  connectionManager.forceReleaseChatConnection(data.chatId);
  clearChatRuntime(data.chatId);
  logger.event("chat.abort", { chatId: data.chatId });
  return { chatId: data.chatId };
}

/**
 * 注册 Chat handlers
 */
export function registerChatHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_SEND, handleChatSend);
  router.register(Method.CHAT_RESUME, handleChatResume);
  router.register(Method.SENSE_APPROVAL, handleSenseApproval);
  router.register(Method.CHAT_ABORT, handleChatAbort);
}
