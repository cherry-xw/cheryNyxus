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
  type SenseApprovalRequestData,
  type SenseApprovalResponseData,
} from "../message/types.js";
import { getChat, addMessage, getMessages, parseMessageRow, fillApprovalResult } from "@/db/chat.js";
import { approvalManager } from "../approval/manager.js";
import { AgentBuilder } from "@/agent/builder.js";
import type { MiddlewareChunk, SenseTriggerChunk, SenseAcceptChunk, SenseRejectChunk, StagedChunk } from "@/core/middleware/types";
import { SupervisionLevel } from "@/core/config";
import type Middleware from "@/core/middleware";
import type { LLMResponse } from "@/core/message/index";
import { logger } from "@/utils/logger/index.js";

/**
 * Chat 运行时缓存：chatId → { builder, middleware, provider }（单 chat 绑定，跨轮不重建）
 *
 * 每个 chatId 独享一个 AgentBuilder 实例（不再全局单例），与 Middleware 一同随 chat 生命周期存在。
 * brain/sense 由 chat.create 原子注入（applyBrain/applySense），中途可经 brain.set/sense.set 更换。
 * provider 缓存自 resolveBrain，供 setSense 复用，免去 ctx 外泄。
 * 实例不重建，messages 天然保留，无需迁移。
 */
interface ChatRuntime {
  builder: AgentBuilder;
  middleware: Middleware<MiddlewareChunk>;
  /** 当前 brain 的 provider（setBrain 时缓存，setSense 依赖） */
  provider?: string;
}

const chatRuntimes = new Map<string, ChatRuntime>();

/**
 * 取 chat 对应的完整运行时（builder + middleware + provider）。
 * ensureChat 后必定存在，缺失则视为内部错误。
 */
async function ensureRuntime(chatId: string): Promise<ChatRuntime> {
  await ensureChat(chatId);
  const runtime = chatRuntimes.get(chatId);
  if (!runtime) {
    throw new Error(`Chat runtime not initialized: ${chatId}`);
  }
  return runtime;
}

/**
 * 应用 brain 配置（resolve brain config + adapters，注入 runtime，缓存 provider）
 * ensureChat 原子配置与 setBrain export 共用。
 */
function applyBrain(runtime: ChatRuntime, brain: string): void {
  const { brain: brainConfig, adapters } = runtime.builder.resolveBrain(brain);
  runtime.middleware.setBrain(brainConfig, adapters);
  runtime.provider = brainConfig.provider;
}

/**
 * 应用 sense 配置（resolve builtSenses + senseTable，注入 runtime）
 * 依赖 runtime.provider，必须先 applyBrain。
 */
function applySense(runtime: ChatRuntime, senseGroups: string[]): void {
  if (!runtime.provider) {
    throw new Error("必须先 setBrain 再 setSense");
  }
  const { builtSenses, senseTable } = runtime.builder.resolveSense(
    runtime.provider,
    senseGroups,
  );
  runtime.middleware.setSense(builtSenses, senseTable);
}

/**
 * 从 DB 加载历史消息到 middleware 内存（幂等由 Middleware.loadHistory 保证）
 * 仅 ensureChat 创建时调用一次，send/resume 不再重复加载。
 */
function loadHistoryInto(agent: Middleware<MiddlewareChunk>, chatId: string): void {
  const rows = getMessages(chatId);
  if (rows.length === 0) {
    return;
  }
  const messages: LLMResponse[] = rows.map((row) => {
    const parsed = parseMessageRow(row);
    return {
      id: row.id,
      role: parsed.role,
      content: parsed.content ?? "",
      thinking: parsed.thinking,
      senseCalls: parsed.senseCall,
      createdAt: row.created_at,
      updateAt: row.created_at,
    };
  });
  agent.loadHistory(messages);
}

/**
 * 获取或创建 chat 对应的 Middleware 实例（单 chat 绑定，跨轮不重建）。
 *
 * 创建时原子完成：注入持久化回调 → setBrain → setSense → loadHistory。
 * 幂等：已存在直接返回，不重新配置。send/resume 不带 brain/senseGroups，
 * 依赖 create 时已配置的 runtime；服务端重启内存丢失后须重新 create。
 *
 * @param brain 可选，chat.create 携带时原子注入；中途换用 brain.set
 * @param senseGroups 可选，依赖 brain 已设置
 */
export async function ensureChat(
  chatId: string,
  brain?: string,
  senseGroups?: string[],
): Promise<Middleware<MiddlewareChunk>> {
  await AgentBuilder.ensureSensesLoaded();

  const existing = chatRuntimes.get(chatId);
  if (existing) {
    return existing.middleware;
  }

  // 每个 chat 独享一个 AgentBuilder 实例（不再全局单例）
  const builder = new AgentBuilder();
  const agent = builder.createMiddleware();
  agent.createChat(chatId);

  // 注入持久化回调（封装边界：middleware 不直接依赖 DB，不外泄 ctx）
  agent.onPersist((msg) => {
    addMessage(msg.id, chatId, {
      role: msg.role,
      content: msg.content,
      thinking: msg.thinking,
      senseCall: msg.senseCalls,
    });
  });
  agent.onUpdate((id: string, content: string) => {
    fillApprovalResult(id, content);
  });

  const runtime: ChatRuntime = { builder, middleware: agent, provider: undefined };
  chatRuntimes.set(chatId, runtime);

  // 原子配置 brain/sense（chat.create 携带时）
  if (brain) {
    applyBrain(runtime, brain);
  }
  if (senseGroups) {
    applySense(runtime, senseGroups);
  }

  // 一次性加载历史到内存
  loadHistoryInto(agent, chatId);

  return agent;
}

/**
 * 设置 brain（resolve brain config + adapters，注入 runtime，缓存 provider）
 * 由 brain.set handler 调用。
 */
export async function setBrain(chatId: string, brain: string): Promise<void> {
  const runtime = await ensureRuntime(chatId);
  applyBrain(runtime, brain);
}

/**
 * 设置 sense（resolve builtSenses + senseTable，注入 runtime）
 * 依赖 runtime.provider，必须先 setBrain。
 * 由 sense.set handler 调用。
 */
export async function setSense(
  chatId: string,
  senseGroups: string[],
): Promise<void> {
  const runtime = await ensureRuntime(chatId);
  applySense(runtime, senseGroups);
}

/**
 * 将 chatId 从运行时缓存移除（删除 chat 时调用）
 */
export function clearChatRuntime(chatId: string): void {
  const runtime = chatRuntimes.get(chatId);
  if (runtime) {
    runtime.middleware.clearChat();
    chatRuntimes.delete(chatId);
  }
}

/**
 * 将 agent generator 的 MiddlewareChunk 转换为 WebSocket 协议的 Chunk/Notification
 * handleChatSend 和 handleChatResume 共用
 */
export async function* streamAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  rid: string,
): AsyncGenerator<Chunk | Notification, void, unknown> {
  let seq = 0;

  for await (const chunk of generator) {
    if (chunk.type === "stream") {
      const streamData: Record<string, unknown> = {};
      if (chunk.thinkingDelta) {
        streamData.thinking = chunk.thinkingDelta;
      }
      if (chunk.contentDelta) {
        streamData.content = chunk.contentDelta;
      }
      if (chunk.senseDelta && chunk.senseDelta.length > 0) {
        streamData.senseCall = chunk.senseDelta;
      }
      yield createChunk("stream", rid, streamData, ++seq);
    } else if (chunk.type === "staged") {
      const staged = chunk as StagedChunk;
      const stagedData: Record<string, unknown> = {
        type: staged.stagedType,
      };
      if (staged.thinking) {
        stagedData.thinking = staged.thinking;
      }
      if (staged.content) {
        stagedData.content = staged.content;
      }
      if (staged.senseName) {
        stagedData.senseName = staged.senseName;
      }
      if (staged.senseArguments) {
        stagedData.arguments = staged.senseArguments;
      }
      yield createChunk("staged", rid, stagedData);
    } else if (chunk.type === "sense_end") {
      const sc = chunk as SenseTriggerChunk;
      logger.info(`[Stream] sense_end, id=${sc.id}, name=${sc.name}, supervision=${sc.supervisionLevel}`);

      // 注册 approvalResolve
      if (sc.approvalResolve) {
        approvalManager.register(sc.id, sc.approvalResolve);
      }

      yield createNotification("interrupt", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        arguments: sc.arguments,
        supervisionLevel: sc.supervisionLevel,
        needsApproval: sc.supervisionLevel > SupervisionLevel.auto,
      });
    } else if (chunk.type === "sense_accept") {
      const sc = chunk as SenseAcceptChunk;
      logger.info(`[Stream] sense_accept, id=${sc.id}, name=${sc.name}`);
      yield createNotification("accept", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        result: sc.result,
      });
    } else if (chunk.type === "sense_reject") {
      const sc = chunk as SenseRejectChunk;
      logger.info(`[Stream] sense_reject, id=${sc.id}, name=${sc.name}`);
      yield createNotification("rejected", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        reason: sc.reason,
      });
    } else if (chunk.type === "consumed") {
      yield createNotification("consumed", rid, { count: (chunk as { count?: number }).count || 0 });
    } else if (chunk.type === "error") {
      const e = chunk as { errors: Array<{ message: string }> };
      yield createNotification("error", rid, { message: e.errors[0]?.message || "Unknown error" });
    } else if (chunk.type === "done") {
      logger.info(`[Stream] done`);
      yield createNotification("done", rid, null);
    }
  }
}

/**
 * 发送聊天消息（流式）
 * brain/sense 由独立的 brain.set/sense.set 设置，send 只携带 chatId + prompt。
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

  logger.info(`[ChatSend] chatId=${chatId}, prompt="${data.prompt}"`);

  const agent = await ensureChat(chatId);
  let failureResponse: RpcResponse | undefined;

  try {
    // history 已在 chat.create 时一次性加载到内存，此处直接 send
    const generator = agent.send(chatId, data.prompt);
    const rid = ctx.requestId ?? chatId;

    yield* streamAgentChunks(generator, rid);
  } catch (err) {
    const error = err as Error;
    const rid = ctx.requestId ?? chatId;
    yield createNotification("error", rid, { message: error.message });
    failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, error.message));
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
  // 调用 approvalResolve
  approvalManager.confirm(data.approvalId, data.action, data.reason);

  // 填充 messages.content（执行结果或拒绝原因）
  const result = data.action === "accept" ? "approved" : `rejected: ${data.reason ?? "user rejected"}`;
  fillApprovalResult(data.approvalId, result);

  return {
    approvalId: data.approvalId,
    action: data.action,
  };
}

/**
 * 注册 Chat handlers
 */
export function registerChatHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_SEND, handleChatSend, true);
  router.register(Method.SENSE_APPROVAL, handleSenseApproval);
}
