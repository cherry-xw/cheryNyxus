import type { HandlerContext } from "../message/router.js";
import { Method, type BrainListResponseData } from "../message/types.js";
import config from "@/utils/config";
import { listConnectedServerNames } from "@/core/mcp";

/**
 * 列出所有可用 brain（config.yaml 中 llm.brain 的键）+ 当前已连 MCP server（供前端渲染开关）。
 */
export async function handleBrainList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<BrainListResponseData> {
  const brains = Object.entries(config.llm.brain).map(([name, cfg]) => ({
    name,
    provider: cfg.provider,
    model: cfg.model,
    thinking: cfg.thinking,
    senseGroups: Object.keys(config.sense_groups ?? {}),
  }));
  return { brains, mcpServers: listConnectedServerNames() };
}

/**
 * 注册 Brain handlers
 */
export function registerBrainHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.BRAIN_LIST, handleBrainList);
}
