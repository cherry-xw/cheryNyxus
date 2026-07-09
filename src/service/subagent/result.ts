import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type SubagentResultRequestData,
  type SubagentResultResponseData,
} from "../message/types.js";
import { resolveSpawnResult } from "@/agent/spawnBroker.js";
import { logger } from "@/utils/logger/index.js";

/**
 * subagent.result RPC handler（CP3）
 *
 * 前端跑完子 agent → 调本方法把子 agent 最终 content 回传给后端 →
 * 唤醒主 agent 挂起的 spawn_subagent sense（wait=true）。
 *
 * 参数：{chatId(子), content}。返回 matched=true/false：
 *   - true: 命中挂起的 spawn（正常路径，主 agent 流被唤醒继续）
 *   - false: 无挂起的 spawn（误调 / wait=false / 主 agent 已 abort）
 *
 * 规则12 fail loud：未命中不静默吞，返回 matched=false 让前端知晓状态错位；
 * 但不抛 404（非异常路径，前端可幂等调用）。
 */
export async function handleSubagentResult(
  _ctx: HandlerContext,
  data: SubagentResultRequestData,
): Promise<SubagentResultResponseData> {
  const { chatId, content } = data;
  const matched = resolveSpawnResult(chatId, content);
  logger.event("subagent.result", { chatId, contentLen: content.length, matched });
  return { chatId, matched };
}

/**
 * 注册 subagent handler。
 */
export function registerSubagentHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.SUBAGENT_RESULT, handleSubagentResult);
}
