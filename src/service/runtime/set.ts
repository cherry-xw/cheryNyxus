import type { RuntimeSelection } from "@/agent/runtimeResolver.js";
import { getChat } from "@/db/chat.js";
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type RuntimeSetRequestData,
  type RuntimeSetResponseData,
} from "../message/types.js";
import { setRuntime } from "../chat/send.js";

function parseRuntimeSelection(params: RuntimeSetRequestData): RuntimeSelection {
  if (!params.brain || !Array.isArray(params.senseGroups) || params.senseGroups.length === 0) {
    throw new Error("runtime.set requires brain and at least one senseGroups entry");
  }
  return {
    brain: params.brain,
    senseGroups: params.senseGroups,
  };
}

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

  const selection = parseRuntimeSelection(p);
  await setRuntime(p.chatId, selection);
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
