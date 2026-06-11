import { AgentBuilder } from "@/agent/builder.js";
import config from "@/utils/config";
import { RpcHandlerError, type HandlerContext } from "../message/router.js";
import { ErrorCode, Method } from "../message/types.js";
import {
  createSoul,
  getSoul,
  listSouls,
  deleteSoul,
  parseSoulRow,
  type SoulData,
} from "@/db/soul.js";
import { listChatsBySoul, getMessages } from "@/db/chat.js";

/**
 * Soul 内存缓存（存储 agent 实例，配置从数据库读取）
 */
export const agentSouls = new Map<string, {
  id: string;
  agent: ReturnType<AgentBuilder["build"]>;
  config: {
    provider: string;
    model: string;
    sense_group: string;
  };
  createdAt: number;
}>();

/**
 * 清理 chat 内存（删除 chat 时调用）
 * 用于同步清理 agent.chatMap，防止删除后重建时数据不一致
 */
export async function clearChatFromMemory(soulId: string, chatId: string): Promise<void> {
  const soul = agentSouls.get(soulId);
  if (soul) {
    const agent = await soul.agent;
    agent.clearChat(chatId);
  }
}

/**
 * 创建 Soul（持久化到数据库）
 */
export async function handleSoulCreate(
  ctx: HandlerContext,
  params: unknown,
): Promise<unknown> {
  const p = params as {
    brain: string;
    sense_group: string;
    soulId?: string;
  };

  const soulId = p.soulId || crypto.randomUUID();

  // 检查数据库中是否已存在（恢复场景）
  const existingSoul = getSoul(soulId);
  if (existingSoul) {
    const parsed = parseSoulRow(existingSoul);
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

    agentSouls.set(soulId, soul);
    ctx.soulId = soulId;

    return { soulId, config: soul.config, createdAt: soul.createdAt, recovered: true };
  }

  // 新建 soul
  const brainConfig = config.llm.brain[p.brain];
  if (!brainConfig) {
    throw new Error(`Brain "${p.brain}" 不存在`);
  }

  // 校验 sense_group 是否存在
  if (!config.sense_groups?.[p.sense_group]) {
    throw new Error(`Sense group "${p.sense_group}" 不存在`);
  }

  const builder = new AgentBuilder().use(p.brain).setSoulId(soulId).setSenseGroup(p.sense_group);
  const agentInstance = builder.build();

  // 持久化到数据库
  const soulData: SoulData = {
    agentName: p.brain,
    provider: brainConfig.provider,
    model: brainConfig.model,
    senseGroup: p.sense_group,
  };
  const row = createSoul(soulId, soulData);

  const soul = {
    id: soulId,
    agent: agentInstance,
    config: {
      provider: brainConfig.provider,
      model: brainConfig.model,
      sense_group: p.sense_group,
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
    throw new RpcHandlerError(ErrorCode.SOUL_HAS_CHATS, "Soul has chats, delete them first");
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
        sense_group: parsed.senseGroup ?? "",
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
  if (!parsed.senseGroup) {
    throw new Error(`Soul "${p.soulId}" has no sense_group configured, please recreate`);
  }

  // 如果内存中没有，载入 agent 实例
  if (!agentSouls.has(p.soulId)) {
    const builder = new AgentBuilder().use(parsed.agentName).setSoulId(p.soulId).setSenseGroup(parsed.senseGroup);
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

  // pending approvals 通过历史消息流判断（role='sense' AND content IS NULL）
  // 这里返回空数组，前端在 chat.get 流式加载时自行判断
  const pendingApprovals: Array<{
    approvalId: string;
    chatId: string;
    createdAt: number;
    senseCalls: unknown[];
  }> = [];

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
 * 获取可用的 sense group 列表
 */
export async function handleSenseList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<unknown> {
  const groups = config.sense_groups
    ? Object.entries(config.sense_groups).map(([name, group]) => ({
        name,
        senses: group.map(item => {
          const colonIndex = item.indexOf(":");
          return colonIndex === -1 ? item : item.slice(0, colonIndex);
        }),
      }))
    : [];
  return { groups };
}

/**
 * 注册 Soul lifecycle handlers
 */
export function registerSoulHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.SOUL_CREATE, handleSoulCreate);
  router.register(Method.SOUL_DELETE, handleSoulDelete);
  router.register(Method.SOUL_LIST, handleSoulList);
  router.register(Method.SOUL_LOAD, handleSoulLoad);
  router.register(Method.SENSE_LIST, handleSenseList);
}
