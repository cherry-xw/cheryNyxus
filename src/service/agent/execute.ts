import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createNotification,
  createResponse,
  Method,
  type Chunk,
  type Notification,
  type Response,
  type ExecuteRequestData,
  type ApprovalRequestData,
} from "../message/types.js";
import { agentSessions } from "./lifecycle.js";
import { createThread, getThread, addMessage } from "@/db/thread.js";
import { getSession, parseSessionRow } from "@/db/session.js";
import { interruptManager } from "./interrupt.js";
import { connectionManager } from "../websocket/connection.js";
import { AgentBuilder } from "@/agent/builder.js";
import { randomUUID } from "crypto";
import type { ToolTriggerChunk, ToolCompleteChunk } from "@/core/middleware/types";

/**
 * 确保 session 存在于内存（从数据库恢复或报错）
 */
async function ensureSession(sessionId: string): Promise<{
  id: string;
  agent: ReturnType<AgentBuilder["build"]>;
  config: {
    provider: string;
    model: string;
    tool_group?: string | string[];
  };
  createdAt: number;
}> {
  // 1. 检查内存
  const memorySession = agentSessions.get(sessionId);
  if (memorySession) {
    return memorySession;
  }

  // 2. 从数据库恢复
  const dbSession = getSession(sessionId);
  if (!dbSession) {
    throw new Error(`Session "${sessionId}" not found`);
  }

  const parsed = parseSessionRow(dbSession);
  const builder = new AgentBuilder().use(parsed.agentName);
  const agentInstance = builder.build();

  const session = {
    id: sessionId,
    agent: agentInstance,
    config: {
      provider: parsed.provider,
      model: parsed.model,
      tool_group: parsed.toolGroup,
    },
    createdAt: parsed.createdAt,
  };

  // 加载到内存
  agentSessions.set(sessionId, session);

  // 加载 pending interrupt handles 到内存
  await interruptManager.loadSessionInterrupts(sessionId);

  return session;
}

/**
 * 执行 Agent（流式）
 */
export async function* handleAgentExecute(
  ctx: HandlerContext,
  data: ExecuteRequestData,
): AsyncGenerator<Chunk | Notification, Response, unknown> {
  // 从内存或数据库恢复 session
  const session = await ensureSession(data.sessionId);

  const threadId = data.threadId || randomUUID();

  // 创建或获取 DB thread
  let thread = getThread(threadId);
  if (!thread) {
    thread = createThread(threadId, data.sessionId);
  }

  // 添加用户消息到 DB
  addMessage(randomUUID(), threadId, { role: "user", content: data.prompt });

  // 测试日志：用户问题
  console.log(`[Execute] threadId=${threadId}, prompt="${data.prompt}"`);

  try {
    const agent = await session.agent;

    // 确保 Middleware 内部 thread 存在
    agent.createThread(threadId);

    const generator = agent.send(threadId, data.prompt);

    let seq = 0;
    let wasThinking = false;
    let thinkingAccumulated = "";  // 累积 thinking 内容
    let contentAccumulated = "";   // 累积 content 内容
    const toolCallsAccumulated: Array<{ id?: string; name?: string; arguments?: string }> = [];  // 累积 tool calls

    for await (const chunk of generator) {
      if (chunk.type === "stream") {
        // Thinking delta
        if (chunk.thinkingDelta) {
          wasThinking = true;
          thinkingAccumulated += chunk.thinkingDelta;
          yield createChunk("stream", threadId, { thinking: chunk.thinkingDelta }, ++seq);
        }

        // Thinking → content 过渡
        if (wasThinking && !chunk.thinkingDelta && chunk.contentDelta) {
          wasThinking = false;
          // 测试日志：thinking 结束
          console.log(`[Execute] thinking_end, thinking="${thinkingAccumulated.slice(0, 100)}..."`);
          yield createChunk("staged", threadId, { type: "thinking_end", thinking: thinkingAccumulated });
        }

        // Content delta
        if (chunk.contentDelta) {
          contentAccumulated += chunk.contentDelta;
          yield createChunk("stream", threadId, { content: chunk.contentDelta }, ++seq);
        }

        // Tool call delta
        if (chunk.toolDelta && chunk.toolDelta.length > 0) {
          for (const tc of chunk.toolDelta) {
            // 累积或更新 tool call
            const idx = tc.index ?? 0;
            if (toolCallsAccumulated[idx]) {
              // 更新现有
              toolCallsAccumulated[idx] = {
                ...toolCallsAccumulated[idx],
                id: tc.id ?? toolCallsAccumulated[idx]?.id,
                name: tc.name ?? toolCallsAccumulated[idx]?.name,
                arguments: (toolCallsAccumulated[idx]?.arguments ?? "") + (tc.arguments ?? ""),
              };
            } else {
              toolCallsAccumulated[idx] = tc;
            }
          }
          yield createChunk("stream", threadId, { toolCall: chunk.toolDelta }, ++seq);
        }
      } else if (chunk.type === "tool_trigger") {
        const tc = chunk as ToolTriggerChunk;
        // 测试日志：tool trigger
        console.log(`[Execute] tool_trigger, id=${tc.id}, name=${tc.name}, args=${tc.arguments.slice(0, 50)}...`);
        yield createNotification("interrupt", threadId, {
          interruptId: tc.id,
          toolName: tc.name,
          arguments: tc.arguments,
          supervisionLevel: tc.supervisionLevel,
        });
      } else if (chunk.type === "tool_complete") {
        const tc = chunk as ToolCompleteChunk;
        // 测试日志：tool complete
        console.log(`[Execute] tool_complete, id=${tc.id}, name=${tc.name}, result=${tc.result.slice(0, 50)}...`);
        yield createNotification("complete", threadId, {
          interruptId: tc.id,
          toolName: tc.name,
          result: tc.result,
        });
      } else if (chunk.type === "consumed") {
        // consumed chunk → 转换为 Notification
        yield createNotification("consumed", threadId, { count: (chunk as { count?: number }).count || 0 });
      } else if (chunk.type === "staged") {
        // checkpoint 发来的 staged chunk
        // 如果 thinking 未在 stream 过程中结束（只有 thinking 没有 content）
        if (wasThinking) {
          wasThinking = false;
          console.log(`[Execute] thinking_end (staged), thinking="${thinkingAccumulated.slice(0, 100)}..."`);
          yield createChunk("staged", threadId, { type: "thinking_end", thinking: thinkingAccumulated });
        }
        // yield content_end
        console.log(`[Execute] content_end, content="${contentAccumulated.slice(0, 100)}..."`);
        yield createChunk("staged", threadId, { type: "content_end", content: contentAccumulated });
      } else if (chunk.type === "error") {
        const e = chunk as { errors: Array<{ message: string }> };
        yield createNotification("error", threadId, { message: e.errors[0]?.message || "Unknown error" });
      } else if (chunk.type === "done") {
        // 测试日志：执行完成汇总
        console.log(`[Execute] done, content="${contentAccumulated.slice(0, 100)}...", toolCalls=${toolCallsAccumulated.length}`);
        yield createNotification("done", threadId, null);
      }
    }
  } catch (err) {
    const error = err as Error;
    yield createNotification("error", threadId, { message: error.message });
  }

  return createResponse(threadId, true, { threadId });
}

/**
 * 审批 Tool
 */
export async function handleToolApproval(
  ctx: HandlerContext,
  data: ApprovalRequestData,
): Promise<Response> {
  await interruptManager.confirmInterrupt(data.interruptId, data.action, data.reason);

  // 审批通过后，清除对应连接的审批超时
  if (data.action === "accept") {
    const connState = connectionManager.getBySessionId(data.sessionId);
    if (connState) {
      for (const [requestId, pending] of connState.pendingRequests) {
        if (pending.interruptId) {
          connectionManager.clearApprovalTimeout(connState.ws, requestId);
          console.log(`审批通过，清除超时: requestId=${requestId}`);
        }
      }
    }
  }

  return createResponse(data.interruptId, true, {
    interruptId: data.interruptId,
    action: data.action,
  });
}

/**
 * 注册 Agent execute handlers
 */
export function registerExecuteHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.AGENT_EXECUTE, handleAgentExecute, true);
  router.register(Method.APPROVAL_TOOL, handleToolApproval);
}