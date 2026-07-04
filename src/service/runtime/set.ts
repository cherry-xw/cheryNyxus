import { parseRuntimeSelection } from "@/agent/runtimeResolver.js";
import { getChat } from "@/db/chat.js";
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type RuntimeSetRequestData,
  type RuntimeSetResponseData,
} from "../message/types.js";
import { setRuntime } from "../chat/send.js";
import { logger } from "@/utils/logger/index.js";

/**
 * 原子设置 chat 的 runtime selection（每轮可换）。
 */
export async function handleRuntimeSet(
  _ctx: HandlerContext,
  params: unknown,
): Promise<RuntimeSetResponseData> {
  const p = params as RuntimeSetRequestData;
  const chat = getChat(p.chatId);
  if (!chat) {
    throw new Error(`Chat "${p.chatId}" not found`);
  }

  const selection = parseRuntimeSelection(p, "runtime.set");
  await setRuntime(p.chatId, selection);
  logger.event("runtime.set", {
    chatId: p.chatId,
    brain: selection.brain,
    senseGroups: selection.senseGroups,
  });
  return {
    chatId: p.chatId,
    brain: selection.brain,
    senseGroups: selection.senseGroups,
  };
}

/**
 * 注册 runtime.set handler。
 */
export function registerRuntimeSetHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.RUNTIME_SET, handleRuntimeSet);
}
