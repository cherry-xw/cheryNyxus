import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type SenseSetRequestData,
  type SenseSetResponseData,
} from "../message/types.js";
import { setSense } from "../chat/send.js";

/**
 * 设置 chat 的 sense（每轮可换）
 * resolve builtSenses + senseTable，注入 ctx.runtime。
 * 依赖 ctx.runtime.brain.provider，必须先 brain.set。
 */
export async function handleSenseSet(
  _ctx: HandlerContext,
  params: unknown,
): Promise<SenseSetResponseData> {
  const p = params as SenseSetRequestData;
  await setSense(p.chatId, p.senseGroups);
  return { chatId: p.chatId, senseGroups: p.senseGroups };
}

/**
 * 注册 sense.set handler
 */
export function registerSenseSetHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.SENSE_SET, handleSenseSet);
}
