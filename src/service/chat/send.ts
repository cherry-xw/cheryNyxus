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
import { agentSouls } from "../soul/lifecycle.js";
import { getChat, addMessage, getMessages, parseMessageRow, fillApprovalResult } from "@/db/chat.js";
import { getSoul, parseSoulRow } from "@/db/soul.js";
import { approvalManager } from "../approval/manager.js";
import { AgentBuilder } from "@/agent/builder.js";
import type { MiddlewareChunk, SenseTriggerChunk, SenseAcceptChunk, SenseRejectChunk, StagedChunk, PersistMessageData } from "@/core/middleware/types";
import { SupervisionLevel } from "@/core/config";
import { logger } from "@/utils/logger/index.js";

/**
 * 确保 Soul 存在于内存（从数据库恢复或报错）
 */
export async function ensureSoul(soulId: string): Promise<{
  id: string;
  agent: ReturnType<AgentBuilder["build"]>;
  config: {
    provider: string;
    model: string;
    sense_group: string;
  };
  createdAt: number;
}> {
  // 1. 检查内存
  const memorySoul = agentSouls.get(soulId);
  if (memorySoul) {
    return memorySoul;
  }

  // 2. 从数据库恢复
  const dbSoul = getSoul(soulId);
  if (!dbSoul) {
    throw new Error(`Soul "${soulId}" not found`);
  }

  const parsed = parseSoulRow(dbSoul);
  if (!parsed.senseGroup) {
    throw new Error(`Soul "${soulId}" has no sense_group configured, please recreate`);
  }
  const builder = new AgentBuilder().use(parsed.agentName).setSoulId(soulId).setSenseGroup(parsed.senseGroup);
  const agentInstance = builder.build();

  const soul = {
    id: soulId,
    agent: agentInstance,
    config: {
      provider: parsed.provider,
      model: parsed.model,
      sense_group: parsed.senseGroup,
    },
    createdAt: parsed.createdAt,
  };

  // 加载到内存
  agentSouls.set(soulId, soul);

  return soul;
}

/**
 * 将 agent generator 的 MiddlewareChunk 转换为 WebSocket 协议的 Chunk/Notification
 * handleChatSend 和 handleChatGet recovery 共用
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
 */
export async function* handleChatSend(
  ctx: HandlerContext,
  data: ChatSendRequestData,
): AsyncGenerator<Chunk | Notification, ChatSendResponseData | RpcResponse, unknown> {
  // 从内存或数据库恢复 soul
  const soul = await ensureSoul(data.soulId);

  // 校验 chatId 必须提供且存在
  if (!data.chatId) {
    throw new Error("chatId is required");
  }
  const chatId = data.chatId;

  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  logger.info(`[ChatSend] chatId=${chatId}, prompt="${data.prompt}"`);

  const agent = await soul.agent;
  let historyMessages: ReturnType<typeof getMessages> = [];
  let failureResponse: RpcResponse | undefined;

  try {
    // 确保 Middleware 内部 chat 存在
    agent.createChat(chatId);

    // 从数据库加载历史消息到 context
    const middlewareCtx = agent.getContext(chatId);
    if (middlewareCtx && middlewareCtx.soul.messages) {
      // 注入消息持久化回调
      middlewareCtx.persistMessage = (msg: PersistMessageData) => {
        addMessage(msg.id, chatId, {
          role: msg.role,
          content: msg.content,
          thinking: msg.thinking,
          senseCall: msg.senseCalls,
        });
      };

      // 注入消息更新回调（pending sense 消息执行后更新 content）
      middlewareCtx.updateMessage = (id: string, content: string) => {
        fillApprovalResult(id, content);
      };

      historyMessages = getMessages(chatId);
      const messages = middlewareCtx.soul.messages;
      const needsLoad = !middlewareCtx.soul.historyLoaded && historyMessages.length > 0;
      if (needsLoad) {
        for (const row of historyMessages) {
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
        middlewareCtx.soul.historyLoaded = true;
      }
    }

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
