import { AgentBuilder } from "@/agent/builder.js";
import config from "@/utils/config";
import type { HandlerContext } from "../message/router.js";
import { createResponse, createError, ErrorCode, Method } from "../message/types.js";
import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  parseSessionRow,
  type SessionData,
} from "@/db/session.js";
import { listThreadsBySession, getMessages, parseMessageRow } from "@/db/thread.js";
import { interruptRepo } from "@/db/interrupt.js";

/**
 * Agent Session 内存缓存（存储 agent 实例，配置从数据库读取）
 */
export const agentSessions = new Map<string, {
  id: string;
  agent: ReturnType<AgentBuilder["build"]>;
  config: {
    provider: string;
    model: string;
    tool_group?: string | string[];
  };
  createdAt: number;
}>();

/**
 * 创建 Agent（持久化到数据库）
 */
export async function handleAgentCreate(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as {
    agent: string;
    sessionId?: string;
  };

  const sessionId = p.sessionId || crypto.randomUUID();

  // 检查数据库中是否已存在（恢复场景）
  const existingSession = getSession(sessionId);
  if (existingSession) {
    const parsed = parseSessionRow(existingSession);
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

    agentSessions.set(sessionId, session);
    ctx.sessionId = sessionId;

    return { sessionId, config: session.config, createdAt: session.createdAt, recovered: true };
  }

  // 新建 session
  const agentConfig = config.llm.agent[p.agent];
  if (!agentConfig) {
    throw new Error(`Agent "${p.agent}" 不存在`);
  }

  const builder = new AgentBuilder().use(p.agent);
  const agentInstance = builder.build();

  // 持久化到数据库
  const sessionData: SessionData = {
    agentName: p.agent,
    provider: agentConfig.provider,
    model: agentConfig.model,
    toolGroup: agentConfig.tool_group,
  };
  const row = createSession(sessionId, sessionData);

  const session = {
    id: sessionId,
    agent: agentInstance,
    config: {
      provider: agentConfig.provider,
      model: agentConfig.model,
      tool_group: agentConfig.tool_group,
    },
    createdAt: row.created_at,
  };

  agentSessions.set(sessionId, session);
  ctx.sessionId = sessionId;

  return { sessionId, config: session.config, createdAt: session.createdAt };
}

/**
 * 删除 Agent（从数据库删除）
 */
export async function handleAgentDelete(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as { sessionId: string };

  const session = agentSessions.get(p.sessionId);
  if (!session) {
    // 检查数据库
    const dbSession = getSession(p.sessionId);
    if (!dbSession) {
      throw new Error(`Session "${p.sessionId}" not found`);
    }
    deleteSession(p.sessionId);
    return { sessionId: p.sessionId };
  }

  agentSessions.delete(p.sessionId);
  deleteSession(p.sessionId);
  return { sessionId: p.sessionId };
}

/**
 * 列出 Agents（从数据库读取）
 */
export async function handleAgentList(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const rows = listSessions();
  const sessions = rows.map(row => {
    const parsed = parseSessionRow(row);
    return {
      sessionId: row.id,
      config: {
        provider: parsed.provider,
        model: parsed.model,
        tool_group: parsed.toolGroup,
      },
      createdAt: row.created_at,
    };
  });
  return { sessions };
}

/**
 * 获取 Session 详情（载入历史 threads + pending interrupts）
 */
export async function handleAgentSession(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as { sessionId: string };

  const dbSession = getSession(p.sessionId);
  if (!dbSession) {
    throw new Error(`Session "${p.sessionId}" not found`);
  }

  const parsed = parseSessionRow(dbSession);

  // 获取 threads，并标记消息类型
  const threads = listThreadsBySession(p.sessionId).map(thread => {
    const rawMessages = getMessages(thread.id);
    const messages = rawMessages.map(row => {
      const parsedMsg = parseMessageRow(row);

      // 判断消息类型
      let type: "thinking_only" | "normal" | "tool_response" = "normal";
      if (row.role === "tool") {
        type = "tool_response";
      } else if (row.role === "assistant" && !row.content && row.thinking) {
        type = "thinking_only";
      }

      return {
        id: row.id,
        role: parsedMsg.role,
        content: parsedMsg.content,
        thinking: parsedMsg.thinking,
        toolCalls: parsedMsg.toolCalls,
        createdAt: row.created_at,
        type,
        // tool 角色消息携带 toolCallId 关联原始 tool call
        toolCallId: row.role === "tool" ? row.id : undefined,
      };
    });

    return {
      threadId: thread.id,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      messageCount: messages.length,
      messages,
    };
  });

  // 获取 pending interrupts
  const interrupts = await interruptRepo.findBySessionId(p.sessionId);
  const pendingInterrupts = interrupts
    .filter(i => i.status === "pending")
    .map(i => ({
      interruptId: i.id,
      threadId: i.threadId,
      createdAt: i.createdAt,
      toolCalls: i.toolCalls,
    }));

  return {
    sessionId: p.sessionId,
    config: {
      provider: parsed.provider,
      model: parsed.model,
      tool_group: parsed.toolGroup,
    },
    createdAt: dbSession.created_at,
    threads,
    pendingInterrupts,
  };
}

/**
 * 注册 Agent lifecycle handlers
 */
export function registerLifecycleHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.AGENT_CREATE, handleAgentCreate);
  router.register(Method.AGENT_DELETE, handleAgentDelete);
  router.register(Method.AGENT_LIST, handleAgentList);
  router.register(Method.AGENT_SESSION, handleAgentSession);
}