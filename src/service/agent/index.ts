export * from "./interrupt.js";
export * from "./lifecycle.js";
export * from "./execute.js";

import type { RpcRouter } from "../message/router.js";
import { registerLifecycleHandlers } from "./lifecycle.js";
import { registerExecuteHandlers } from "./execute.js";

/**
 * 注册所有 Agent handlers
 */
export function registerAgentHandlers(router: RpcRouter): void {
  registerLifecycleHandlers(router);
  registerExecuteHandlers(router);
}