import type { HandlerContext } from "../message/router.js";
import { Method, type SenseListResponseData } from "../message/types.js";
import config from "@/utils/config";

/**
 * 列出所有可用 sense group（config.yaml 中 sense_groups 的键）
 */
export async function handleSenseList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<SenseListResponseData> {
  const senseGroups = Object.entries(config.sense_groups ?? {}).map(([name, senses]) => ({
    name,
    senses,
  }));
  return { senseGroups };
}

/**
 * 注册 Sense handlers
 */
export function registerSenseHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.SENSE_LIST, handleSenseList);
}
