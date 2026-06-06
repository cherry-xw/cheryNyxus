import { AgentBuilder } from "@/agent/builder.js";
import config from "@/utils/config";
import type { HandlerContext } from "../message/router.js";
import { createResponse, createError, ErrorCode, Method } from "../message/types.js";
import {
  createSoul,
  getSoul,
  listSouls,
  deleteSoul,
  parseSoulRow,
  type SoulData,
} from "@/db/soul.js";
import { listChatsBySoul, getMessages, parseMessageRow } from "@/db/chat.js";
import { approvalRepo } from "@/db/approval.js";

/**
 * Soul 内存缓存（存储 agent 实例，配置从数据库读取）
 */
export const agentSouls = new Map<string, {
  id: string;
  agent: ReturnType<AgentBuilder["build"]>;
  config: {
    provider: string;
    model: string;
    sense_group?: string | string[];
  };
  createdAt: number;
}>();

/**
 * 创建 Soul（持久化到数据库）
 */
export async function handleSoulCreate(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as {
    brain: string;
    soulId?: string;
  };

  const soulId = p.soulId || crypto.randomUUID();

  // 检查数据库中是否已存在（恢复场景）
  const existingSoul = getSoul(soulId);
  if (existingSoul) {
    const parsed = parseSoulRow(existingSoul);
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

    agentSouls.set(soulId, soul);
    ctx.soulId = soulId;

    return { soulId, config: soul.config, createdAt: soul.createdAt, recovered: true };
  }

  // 新建 soul
  const brainConfig = config.llm.brain[p.brain];
  if (!brainConfig) {
    throw new Error(`Brain "${p.brain}" 不存在`);
  }

  const builder = new AgentBuilder().use(p.brain);
  const agentInstance = builder.build();

  // 持久化到数据库
  const soulData: SoulData = {
    agentName: p.brain,
    provider: brainConfig.provider,
    model: brainConfig.model,
    senseGroup: brainConfig.sense_group,
  };
  const row = createSoul(soulId, soulData);

  const soul = {
    id: soulId,
    agent: agentInstance,
    config: {
      provider: brainConfig.provider,
      model: brainConfig.model,
      sense_group: brainConfig.sense_group,
    },
    createdAt: row.created_at,
  };

  agentSouls.set(soulId, soul);
  ctx.soulId = soulId;

  return { soulId, config: soul.config, createdAt: soul.createdAt };
}

/**
 * 删除 Soul（从数据库删除，需先删除所有 Chat）
 */
export async function handleSoulDelete(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as { soulId: string };

  // 级联检查：是否有关联 Chat
  const chats = listChatsBySoul(p.soulId);
  if (chats.length > 0) {
    return createError("SOUL_HAS_CHATS", "Soul has chats, delete them first");
  }

  const soul = agentSouls.get(p.soulId);
  if (!soul) {
    // 检查数据库
    const dbSoul = getSoul(p.soulId);
    if (!dbSoul) {
      throw new Error(`Soul "${p.soulId}" not found`);
    }
    deleteSoul(p.soulId);
    return { soulId: p.soulId };
  }

  agentSouls.delete(p.soulId);
  deleteSoul(p.soulId);
  return { soulId: p.soulId };
}

/**
 * 列出 Souls（从数据库读取）
 */
export async function handleSoulList(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const rows = listSouls();
  const souls = rows.map(row => {
    const parsed = parseSoulRow(row);
    return {
      soulId: row.id,
      config: {
        provider: parsed.provider,
        model: parsed.model,
        sense_group: parsed.senseGroup,
      },
      createdAt: row.created_at,
    };
  });
  return { souls };
}

/**
 * 载入 Soul（载入历史 chats + pending approvals）
 */
export async function handleSoulLoad(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as { soulId: string };

  const dbSoul = getSoul(p.soulId);
  if (!dbSoul) {
    throw new Error(`Soul "${p.soulId}" not found`);
  }

  const parsed = parseSoulRow(dbSoul);

  // 如果内存中没有，载入 agent 实例
  if (!agentSouls.has(p.soulId)) {
    const builder = new AgentBuilder().use(parsed.agentName);
    const agentInstance = builder.build();

    agentSouls.set(p.soulId, {
      id: p.soulId,
      agent: agentInstance,
      config: {
        provider: parsed.provider,
        model: parsed.model,
        sense_group: parsed.senseGroup,
      },
      createdAt: parsed.createdAt,
    });
  }

  ctx.soulId = p.soulId;

  // 获取 chats
  const chats = listChatsBySoul(p.soulId).map(chat => {
    const messages = getMessages(chat.id);
    return {
      chatId: chat.id,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      messageCount: messages.length,
    };
  });

  // 获取 pending approvals
  const approvals = await approvalRepo.findBySoulId(p.soulId);
  const pendingApprovals = approvals
    .filter(a => a.status === "pending")
    .map(a => ({
      approvalId: a.id,
      chatId: a.chatId,
      createdAt: a.createdAt,
      senseCalls: a.senseCalls,
    }));

  return {
    soulId: p.soulId,
    config: {
      provider: parsed.provider,
      model: parsed.model,
      sense_group: parsed.senseGroup,
    },
    createdAt: dbSoul.created_at,
    chats,
    pendingApprovals,
  };
}

/**
 * 注册 Soul lifecycle handlers
 */
export function registerSoulHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.SOUL_CREATE, handleSoulCreate);
  router.register(Method.SOUL_DELETE, handleSoulDelete);
  router.register(Method.SOUL_LIST, handleSoulList);
  router.register(Method.SOUL_LOAD, handleSoulLoad);
}