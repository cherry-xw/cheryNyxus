import { parseRuntimeSelection } from "@/agent/runtimeResolver.js";
import { getChat, getChatPreset, getChatRuntimeSelection } from "@/db/chat.js";
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type RuntimeSetRequestData,
  type RuntimeSetResponseData,
} from "../message/types.js";
import { setRuntime } from "../chat/runtime.js";
import { logger } from "@/utils/logger/index.js";

/**
 * 顺序敏感的字符串数组相等（senseGroups 顺序影响监管覆盖解析，需精确匹配）。
 */
function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * 设置 chat 的 runtime selection。
 * - preset chat（metadata.preset 存在）：**编制锁定**，仅 brain 可覆盖；senseGroups/mcpServers 强制取创建快照。
 *   显式带了与快照不同的 senseGroups/mcp → fail loud（防前端绕过锁定，规则12）。
 * - 非 preset chat：完整 brain+senseGroups+mcp 语义（每轮可换，原行为）。
 */
export async function handleRuntimeSet(
  _ctx: HandlerContext,
  data: RuntimeSetRequestData,
): Promise<RuntimeSetResponseData> {
  const p = data;
  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error("这个会话不见了");
  }

  let brain: string;
  let senseGroup: string;
  let mcpServers: string[];
  const presetName = getChatPreset(p.chatId);
  if (presetName) {
    // 编制锁定：取创建快照的 senseGroup/mcp，brain 用传入值
    const snapshot = getChatRuntimeSelection(p.chatId);
    if (!snapshot) {
      throw new Error("预设会话的运行配置丢了（数据异常）");
    }
    if (p.senseGroup !== undefined && p.senseGroup !== snapshot.senseGroup) {
      throw new Error("预设会话的编制已锁定，感官组不能改");
    }
    if (p.mcpServers && !sameArray(p.mcpServers, snapshot.mcpServers)) {
      throw new Error("预设会话的编制已锁定，扩展工具不能改");
    }
    brain = p.brain;
    senseGroup = snapshot.senseGroup;
    mcpServers = snapshot.mcpServers;
  } else {
    const selection = parseRuntimeSelection(p, "runtime.set");
    brain = selection.brain;
    senseGroup = selection.senseGroup;
    mcpServers = selection.mcpServers;
  }

  const selection = { brain, senseGroup, mcpServers };
  await setRuntime(p.chatId, selection);
  logger.event("runtime.set", {
    chatId: p.chatId,
    preset: presetName,
    brain,
    senseGroup,
    mcpServers,
  });
  return { chatId: p.chatId, brain, senseGroup, mcpServers };
}

/**
 * 注册 runtime.set handler。
 */
export function registerRuntimeSetHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.RUNTIME_SET, handleRuntimeSet);
}
