import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type BrainSetRequestData,
  type BrainSetResponseData,
} from "../message/types.js";
import { setBrain } from "../chat/send.js";

/**
 * 设置 chat 的 brain（每轮可换）
 * resolve brain config + adapters，注入 ctx.runtime。
 * 必须在 chat.send 前调用。
 */
export async function handleBrainSet(
  _ctx: HandlerContext,
  params: unknown,
): Promise<BrainSetResponseData> {
  const p = params as BrainSetRequestData;
  await setBrain(p.chatId, p.brain);
  return { chatId: p.chatId, brain: p.brain };
}

/**
 * 注册 brain.set handler
 */
export function registerBrainSetHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.BRAIN_SET, handleBrainSet);
}
