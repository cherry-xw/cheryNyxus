import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createNotification,
  createResponse,
  Method,
  type Chunk,
  type Notification,
  type Response,
  type ChatSendRequestData,
  type SenseApprovalRequestData,
} from "../message/types.js";
import { agentSouls } from "../soul/lifecycle.js";
import { createChat, getChat, addMessage, getMessages, parseMessageRow } from "@/db/chat.js";
import { getSoul, parseSoulRow } from "@/db/soul.js";
import { approvalManager } from "../approval/manager.js";
import { connectionManager } from "../websocket/connection.js";
import { AgentBuilder } from "@/agent/builder.js";
import { randomUUID } from "crypto";
import type { SenseTriggerChunk, SenseCompleteChunk } from "@/core/middleware/types";

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
  const builder = new AgentBuilder().use(parsed.agentName);
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
): AsyncGenerator<Chunk | Notification, Response, unknown> {
  // 从内存或数据库恢复 soul
  const soul = await ensureSoul(data.soulId);

  const chatId = data.chatId || randomUUID();

  // 创建或获取 DB chat
  let chat = getChat(chatId);
  if (!chat) {
    chat = createChat(chatId, data.soulId);
  }

  // 添加用户消息到 DB
  addMessage(randomUUID(), chatId, { role: "user", content: data.prompt });

  // 测试日志：用户问题
  console.log(`[ChatSend] chatId=${chatId}, prompt="${data.prompt}"`);

  try {
    const agent = await soul.agent;

    // 确保 Middleware 内部 chat 存在
    agent.createChat(chatId);

    const generator = agent.send(chatId, data.prompt);

    let seq = 0;
    let wasThinking = false;
    let thinkingAccumulated = "";  // 累积 thinking 内容
    let contentAccumulated = "";   // 累积 content 内容
    const senseCallsAccumulated: Array<{ id?: string; name?: string; arguments?: string }> = [];  // 累积 sense calls

    for await (const chunk of generator) {
      if (chunk.type === "stream") {
        // Thinking delta
        if (chunk.thinkingDelta) {
          wasThinking = true;
          thinkingAccumulated += chunk.thinkingDelta;
          yield createChunk("stream", chatId, { thinking: chunk.thinkingDelta }, ++seq);
        }

        // Thinking → content 过渡
        if (wasThinking && !chunk.thinkingDelta && chunk.contentDelta) {
          wasThinking = false;
          console.log(`[ChatSend] thinking_end, thinking="${thinkingAccumulated.slice(0, 100)}..."`);
          yield createChunk("staged", chatId, { type: "thinking_end", thinking: thinkingAccumulated });
        }

        // Content delta
        if (chunk.contentDelta) {
          contentAccumulated += chunk.contentDelta;
          yield createChunk("stream", chatId, { content: chunk.contentDelta }, ++seq);
        }

        // Sense call delta
        if (chunk.senseDelta && chunk.senseDelta.length > 0) {
          for (const sc of chunk.senseDelta) {
            const idx = sc.index ?? 0;
            if (senseCallsAccumulated[idx]) {
              senseCallsAccumulated[idx] = {
                ...senseCallsAccumulated[idx],
                id: sc.id ?? senseCallsAccumulated[idx]?.id,
                name: sc.name ?? senseCallsAccumulated[idx]?.name,
                arguments: (senseCallsAccumulated[idx]?.arguments ?? "") + (sc.arguments ?? ""),
              };
            } else {
              senseCallsAccumulated[idx] = sc;
            }
          }
          yield createChunk("stream", chatId, { senseCall: chunk.senseDelta }, ++seq);
        }
      } else if (chunk.type === "sense_trigger") {
        const sc = chunk as SenseTriggerChunk;
        console.log(`[ChatSend] sense_trigger, id=${sc.id}, name=${sc.name}, args=${sc.arguments.slice(0, 50)}...`);

        // 注册审批到 approvalManager（存储 approvalResolve）
        approvalManager.registerFromTrigger(sc, data.soulId, chatId);

        yield createNotification("interrupt", chatId, {
          approvalId: sc.id,
          senseName: sc.name,
          arguments: sc.arguments,
          supervisionLevel: sc.supervisionLevel,
        });
      } else if (chunk.type === "sense_complete") {
        const sc = chunk as SenseCompleteChunk;
        console.log(`[ChatSend] sense_complete, id=${sc.id}, name=${sc.name}, result=${sc.result.slice(0, 50)}...`);
        yield createNotification("complete", chatId, {
          approvalId: sc.id,
          senseName: sc.name,
          result: sc.result,
        });
      } else if (chunk.type === "consumed") {
        yield createNotification("consumed", chatId, { count: (chunk as { count?: number }).count || 0 });
      } else if (chunk.type === "staged") {
        if (wasThinking) {
          wasThinking = false;
          console.log(`[ChatSend] thinking_end (staged), thinking="${thinkingAccumulated.slice(0, 100)}..."`);
          yield createChunk("staged", chatId, { type: "thinking_end", thinking: thinkingAccumulated });
        }
        console.log(`[ChatSend] content_end, content="${contentAccumulated.slice(0, 100)}..."`);
        yield createChunk("staged", chatId, { type: "content_end", content: contentAccumulated });
      } else if (chunk.type === "error") {
        const e = chunk as { errors: Array<{ message: string }> };
        yield createNotification("error", chatId, { message: e.errors[0]?.message || "Unknown error" });
      } else if (chunk.type === "done") {
        console.log(`[ChatSend] done, content="${contentAccumulated.slice(0, 100)}...", senseCalls=${senseCallsAccumulated.length}`);
        yield createNotification("done", chatId, null);
      }
    }
  } catch (err) {
    const error = err as Error;
    yield createNotification("error", chatId, { message: error.message });
  }

  return createResponse(chatId, true, { chatId });
}

/**
 * 审批 Sense
 */
export async function handleSenseApproval(
  ctx: HandlerContext,
  data: SenseApprovalRequestData,
): Promise<Response> {
  await approvalManager.confirmApproval(data.approvalId, data.action, data.reason);

  // 审批通过后，清除对应连接的审批超时
  if (data.action === "accept") {
    const connState = connectionManager.getBySoulId(data.soulId);
    if (connState) {
      for (const [requestId, pending] of connState.pendingRequests) {
        if (pending.approvalId) {
          connectionManager.clearApprovalTimeout(connState.ws, requestId);
          console.log(`审批通过，清除超时: requestId=${requestId}`);
        }
      }
    }
  }

  return createResponse(data.approvalId, true, {
    approvalId: data.approvalId,
    action: data.action,
  });
}

/**
 * 注册 Chat handlers
 */
export function registerChatHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_SEND, handleChatSend, true);
  router.register(Method.SENSE_APPROVAL, handleSenseApproval);
}