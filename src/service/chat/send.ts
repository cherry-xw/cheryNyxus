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
import { getChat, addMessage, getMessages, parseMessageRow } from "@/db/chat.js";
import { getSoul, parseSoulRow } from "@/db/soul.js";
import { approvalManager } from "../approval/manager.js";
import { connectionManager } from "../websocket/connection.js";
import { AgentBuilder } from "@/agent/builder.js";
import type { SenseTriggerChunk, SenseAcceptChunk, SenseRejectChunk, StagedChunk, PersistMessageData } from "@/core/middleware/types";
import { SupervisionLevel } from "@/core/config";
import { logger } from "@/utils/logger/index.js";

/**
 * 确保 Soul 存在于内存（从数据库恢复或报错）
 */
async function ensureSoul(soulId: string): Promise<{
  id: string;
  agent: ReturnType<AgentBuilder["build"]>;
  config: {
    provider: string;
    model: string;
    sense_group?: string | string[];
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
  const builder = new AgentBuilder().use(parsed.agentName).setSoulId(soulId);
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

  // 加载 pending approval handles 到内存
  await approvalManager.loadSoulApprovals(soulId);

  return soul;
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

  // 测试日志：用户问题
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
      // 注入消息持久化回调（middleware 层通过回调写入 DB，不直接依赖 DB）
      middlewareCtx.persistMessage = (msg: PersistMessageData) => {
        addMessage(msg.id, chatId, {
          role: msg.role,
          content: msg.content,
          thinking: msg.thinking,
          senseCall: msg.senseCalls,
        });
      };

      historyMessages = getMessages(chatId);
      const messages = middlewareCtx.soul.messages;
      // 使用 historyLoaded 标记判断是否需要加载历史（不依赖 messages.length）
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
        // 标记已加载，防止重复加载
        middlewareCtx.soul.historyLoaded = true;
      }
    }

    const generator = agent.send(chatId, data.prompt);

    let seq = 0;
    const rid = ctx.requestId ?? chatId;

    for await (const chunk of generator) {
      if (chunk.type === "stream") {
        // Stream delta - 透传
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
        // Staged chunk - checkpoint 已处理，直接透传
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
        logger.info(`[ChatSend] sense_end, id=${sc.id}, name=${sc.name}, args=${sc.arguments}, supervisionLevel=${sc.supervisionLevel}`);

        // 注册审批到 approvalManager（存储 approvalResolve）
        await approvalManager.registerFromTrigger(sc, data.soulId, chatId);

        yield createNotification("interrupt", rid, {
          approvalId: sc.id,
          senseName: sc.name,
          arguments: sc.arguments,
          supervisionLevel: sc.supervisionLevel,
          needsApproval: sc.supervisionLevel > SupervisionLevel.auto,
        });
      } else if (chunk.type === "sense_accept") {
        const sc = chunk as SenseAcceptChunk;
        logger.info(`[ChatSend] sense_accept, id=${sc.id}, name=${sc.name}, result=${sc.result}`);
        yield createNotification("accept", rid, {
          approvalId: sc.id,
          senseName: sc.name,
          result: sc.result,
        });
      } else if (chunk.type === "sense_reject") {
        const sc = chunk as SenseRejectChunk;
        logger.info(`[ChatSend] sense_reject, id=${sc.id}, name=${sc.name}, reason=${sc.reason}`);
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
        logger.info(`[ChatSend] done`);
        yield createNotification("done", rid, null);
      }
    }
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
  ctx: HandlerContext,
  data: SenseApprovalRequestData,
): Promise<SenseApprovalResponseData> {
  await approvalManager.confirmApproval(data.approvalId, data.action, data.reason);

  // 审批通过后，清除对应连接的审批超时
  if (data.action === "accept") {
    const connState = connectionManager.getBySoulId(data.soulId);
    if (connState) {
      for (const [requestId, pending] of connState.pendingRequests) {
        if (pending.approvalId) {
          connectionManager.clearApprovalTimeout(connState.ws, requestId);
          logger.info(`审批通过，清除超时: requestId=${requestId}`);
        }
      }
    }
  }

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