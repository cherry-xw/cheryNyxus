import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createError,
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
  type SenseQuestionAnswerRequestData,
  type SenseQuestionAnswerResponseData,
  type ChatAbortRequestData,
  type ChatAbortResponseData,
} from "../message/types.js";
import { getChat, markMessagesRevoked, updateChatMetadata } from "@/db/chat.js";
import { approvalManager } from "../approval/manager.js";
import { questionManager } from "../question/manager.js";
import { connectionManager } from "../websocket/connection.js";
import {
  ensureChat,
  clearChatRuntime,
  abortChatRuntime,
  getChatSelection,
  getActiveChatRunId,
  activateChatRun,
  releaseChatRun,
} from "./runtime.js";
import { clearWaitedChildrenByParent } from "@/agent/spawnBroker.js";
import { observeAgentChunks } from "./observer.js";
import { streamAgentChunks } from "./streamMapper.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";
import { isAgentAbortError } from "@/core/middleware/errors.js";
import { safeJsonParse } from "@/utils/json.js";
import { randomUUID } from "crypto";

// P2-1：runtime 缓存/observer/streamMapper 已按职责拆出。
// runtime API（ensureChat/clearChatRuntime/setRuntime/abortChatRuntime）由 ./runtime.js 直接导出，
// 调用方（handler.ts/runtime set.ts）直接 import runtime.js，不再经 send 转发。

// P4：mimeType → 扩展名映射（与服务端 media/index.ts MIME_KIND 对齐，标 marker 供 enrichMediaInputs 解析）。
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

/**
 * P4：将结构化 attachments 转为 [[media:<filename>]] 文本标记，附加到 prompt 末尾。
 * enrichMediaInputs 仍以文本标记为解析入口；前端不再发 marker，服务端补 marker 保持向后兼容。
 * 当 mimeType 不在映射中时使用 .bin（MIME_KIND 已先在 saveMediaAsset 校验）。
 */
function attachmentsToPromptMarkers(
  attachments: ChatSendRequestData["attachments"],
  basePrompt: string,
): string {
  if (!attachments || attachments.length === 0) return basePrompt;
  const markers = attachments
    .map((a) => {
      const ext = MIME_EXT[a.mimeType.toLowerCase()] ?? ".bin";
      return `[[media:${a.assetId}${ext}]]`;
    })
    .join("\n");
  return basePrompt ? `${basePrompt}\n${markers}` : markers;
}

/**
 * 发送聊天消息（流式）
 * runtime 由 chat.create/runtime.set 设置，send 只携带 chatId + prompt。
 */
export async function* handleChatSend(
  ctx: HandlerContext,
  data: ChatSendRequestData,
): AsyncGenerator<Chunk | Notification, ChatSendResponseData | RpcResponse, unknown> {
  const chatId = data.chatId;
  // runId 与启动该运行的 RPC id 同源；脱离 WS 的单元调用使用 UUID 兜底。
  const runId = ctx.requestId ?? randomUUID();

  // 校验 chat 存在
  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  logger.event("chat.send.start", {
    mode: "send",
    chatId,
    runtime: getChatSelection(chatId),
    promptLen: data.prompt.length,
    promptPreview: data.prompt.slice(0, 200),
    attachmentCount: data.attachments?.length ?? 0,
  });

  const agent = await ensureChat(chatId);
  const rid = ctx.requestId ?? runId;

  // P4：结构化 attachments → [[media:<filename>]] 文本标记追加到 prompt。
  // enrichMediaInputs 仍以文本标记解析；P5 provider 多模态直接读 LLMResponse.attachments 时可省此步。
  const promptWithAttachments = attachmentsToPromptMarkers(data.attachments, data.prompt);

  // 运行中 send：仅入队（迭代触发 send body push userInputs），不绑定连接、不走流。
  // 避免空 generator（isRunning 时 send return 空 gen）立即结束而 finally 误释放当前活跃连接绑定（P0-1）。
  // 新输出跟随当前活跃流发出，客户端无需此流响应。
  if (agent.isRunning()) {
    for await (const _ of agent.run(promptWithAttachments)) {
      /* 运行中 send 不产出 chunk，迭代仅为触发 send body 入队 */
    }
    logger.event("chat.send.queued", { chatId, runtime: getChatSelection(chatId), promptLen: promptWithAttachments.length });
    return { chatId, runId: getActiveChatRunId(chatId) ?? runId, queued: true };
  }

  // 绑定 chatId 到当前连接，拒绝跨连接并发 send（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId);
    logger.event("chat.bind", { chatId, connectionId: ctx.connectionId });
  } catch (e) {
    const msg = (e as Error).message;
    logger.event("chat.bind.failed", { chatId, message: msg }, LogLevel.error);
    return createResponse(rid, false, undefined, createError(ErrorCode.CONFLICT, msg));
  }

  activateChatRun(chatId, runId);

  // 恢复场景撤回：仅 idle 时触发（运行中 send 只入队，不撤回）。
  // 撤回末尾整个当前周期 AI 响应（assistant think/content/tool + 整个 sense 群），
  // 发 staged.reverse chunk 通知客户端回滚，再 run 用新 prompt 重跑。
  if (!agent.isRunning()) {
    const revokedIds = agent.revokeTrailingCycle();
    if (revokedIds.length > 0) {
      markMessagesRevoked(chatId, revokedIds);
      logger.event("chat.send.revoke", { count: revokedIds.length, messageIds: revokedIds });
      yield createChunk("staged", rid, { type: "reverse", messageIds: revokedIds }, { chatId, runId });
    }
  }

  let failureResponse: RpcResponse | undefined;
  let failureMessage: string | undefined;
  // user message 落库后 observer 回调写入 msgId → Response.data 回前端
  // （前端 sendMessage 即时 push user prompt 到 stream.history 时携带 msgId，下次 reload dedup 用）
  let userMsgId: string | undefined;

  try {
    // history 已在 chat.create 时一次性加载到内存。
    // 若当前 chat 正在运行，send 只入队输入；新输出会跟随已有运行流发出。
    // onError 回调：streamMapper 见到 ErrorChunk 时调用，无 throw 时也能构造 failureResponse。
    // P4：传 promptWithAttachments（含 [[media:]] 标记）供 enrichMediaInputs 解析。
    const generator = observeAgentChunks(
      agent.run(promptWithAttachments),
      chatId,
      () => agent.getMessages(),
      (msgId) => { userMsgId = msgId; },
    );

    yield* streamAgentChunks(generator, rid, chatId, runId, (msg) => { failureMessage = msg; });
  } catch (err) {
    const error = err as Error;
    // approval aborted（chat.abort 触发 abortChat → reject → senseMiddleware throw，
    // 见 tool.ts executeCollectedCalls catch）：chat.abort 是预期清内存操作，静默不报错。
    if (isAgentAbortError(error)) {
      logger.event("chat.send.aborted", { reason: "approval aborted" });
    } else {
      logger.event("chat.send.error", { message: error.message, stack: error.stack }, LogLevel.error);
      failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, error.message));
    }
  } finally {
    releaseChatRun(chatId, runId);
    connectionManager.releaseChatConnection(chatId, ctx.connectionId);
    logger.event("chat.release", { chatId, connectionId: ctx.connectionId });
  }

  // 防御性：retry-yielded ErrorChunk（不 throw）经 streamMapper 收集的 message → 构造 failureResponse，
  // 避免「error notification + done notification + Response.success:true」三发歧义。
  if (failureMessage && !failureResponse) {
    failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, failureMessage));
  }

  return failureResponse ?? { chatId, runId, ...(userMsgId ? { userMsgId } : {}) };
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
  const runId = ctx.requestId ?? randomUUID();
  const rid = ctx.requestId ?? runId;

  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  logger.event("chat.send.start", { mode: "resume" });

  const resumeWasPending = chat.metadata
    ? safeJsonParse<{ resumePending?: boolean }>(chat.metadata, {}).resumePending === true
    : false;

  const agent = await ensureChat(chatId);

  // 运行中 resume：无意义（无 prompt 入队，活跃流已在跑），直接返回避免重复启动流误释放绑定（P0-1）
  if (agent.isRunning()) {
    return { chatId, runId: getActiveChatRunId(chatId) ?? runId, alreadyRunning: true };
  }

  // 绑定 chatId 到当前连接，拒绝跨连接并发 resume（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId);
    logger.event("chat.bind", { chatId, connectionId: ctx.connectionId });
  } catch (e) {
    const msg = (e as Error).message;
    logger.event("chat.bind.failed", { chatId, message: msg }, LogLevel.error);
    return createResponse(rid, false, undefined, createError(ErrorCode.CONFLICT, msg));
  }

  activateChatRun(chatId, runId);

  let failureResponse: RpcResponse | undefined;
  let failureMessage: string | undefined;
  try {
    // 仅消费本次已持久化的待恢复标记；运行期间新到的角色结果会由 wakeParent 再次置 true。
    if (resumeWasPending) updateChatMetadata(chatId, { resumePending: false });
    // resume 内部据末尾状态决定 Case1/Case2（见 builder.resume）
    const generator = observeAgentChunks(agent.resume(), chatId, () => agent.getMessages());
    yield* streamAgentChunks(generator, rid, chatId, runId, (msg) => { failureMessage = msg; });
  } catch (err) {
    const error = err as Error;
    // approval aborted（chat.abort 触发，同 handleChatSend）：静默不报错
    if (isAgentAbortError(error)) {
      logger.event("chat.send.aborted", { reason: "approval aborted" });
    } else {
      logger.event("chat.send.error", { message: error.message, stack: error.stack }, LogLevel.error);
      failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, error.message));
    }
  } finally {
    releaseChatRun(chatId, runId);
    connectionManager.releaseChatConnection(chatId, ctx.connectionId);
    logger.event("chat.release", { chatId, connectionId: ctx.connectionId });
  }

  if (failureMessage && !failureResponse) {
    failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, failureMessage));
  }

  // resumePending 恢复策略（覆盖 resume 无 assistant 输出场景）：
  // - 有 failureResponse（异常 / LLM 报错）→ 恢复（原逻辑）
  // - 无 failureResponse 但末条非 assistant（LLM 空响应 / loop 异常结束）→ 恢复
  // 判据：agent.getMessages() 末条非 revoked 消息的 role !== "assistant"
  // 这样重连后 rebuildSpawnWaits 能识别 idle+canResume 主 chat 再次 resume。
  if (resumeWasPending) {
    const msgs = agent.getMessages();
    const lastVisible = [...msgs].reverse().find(m => !m.revoked);
    const producedAssistant = !!lastVisible && lastVisible.role === "assistant";
    if (failureResponse || !producedAssistant) {
      updateChatMetadata(chatId, { resumePending: true });
      if (!failureResponse) {
        logger.event("resume.restore-no-assistant", { chatId, lastRole: lastVisible?.role ?? "none" });
      }
    }
  }

  return failureResponse ?? { chatId, runId };
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
 * 回答 ask_user_question 感官（RPC → service QuestionManager.confirm → core questionRegistry.resolveQuestion
 * → sense handler 的 await createQuestion 即时返回）。
 */
export async function handleSenseQuestionAnswer(
  _ctx: HandlerContext,
  data: SenseQuestionAnswerRequestData,
): Promise<SenseQuestionAnswerResponseData> {
  const cancelled = data.cancelled === true;
  questionManager.confirm(data.questionId, {
    selectedLabels: data.selectedLabels,
    ...(data.freeText !== undefined ? { freeText: data.freeText } : {}),
    cancelled,
  });
  logger.event("sense.question.answer", {
    questionId: data.questionId,
    selectedLabels: data.selectedLabels,
    hasFreeText: data.freeText !== undefined,
    cancelled,
  });

  return { questionId: data.questionId, cancelled };
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
  ctx: HandlerContext,
  data: ChatAbortRequestData,
): Promise<ChatAbortResponseData | RpcResponse> {
  const activeRunId = getActiveChatRunId(data.chatId);
  if (data.runId && activeRunId && data.runId !== activeRunId) {
    return createResponse(
      ctx.requestId ?? "",
      false,
      undefined,
      createError(ErrorCode.CONFLICT, `Chat "${data.chatId}" is running as "${activeRunId}", not "${data.runId}"`),
    );
  }
  if (!activeRunId) {
    return { chatId: data.chatId, aborted: false };
  }

  abortChatRuntime(data.chatId);
  // T9：主被 abort → 清其 wait-子唤醒链，防子完成反唤醒已停的主（用户主动停语义）
  clearWaitedChildrenByParent(data.chatId);
  // 强制解绑连接（不校验 owner）：abort 是清内存操作，跨连接重连后旧 owner 须无条件清除避免 busy 死锁（P0-2）
  connectionManager.forceReleaseChatConnection(data.chatId);
  clearChatRuntime(data.chatId);
  logger.event("chat.abort", { chatId: data.chatId, runId: activeRunId });
  return { chatId: data.chatId, runId: activeRunId, aborted: true };
}

/**
 * 注册 Chat handlers
 */
export function registerChatHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_SEND, handleChatSend);
  router.register(Method.CHAT_RESUME, handleChatResume);
  router.register(Method.SENSE_APPROVAL, handleSenseApproval);
  router.register(Method.SENSE_QUESTION_ANSWER, handleSenseQuestionAnswer);
  router.register(Method.CHAT_ABORT, handleChatAbort);
}
