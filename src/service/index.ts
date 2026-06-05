import { createRouter } from "./message/router.js";
import { createWebSocketServer } from "./websocket/index.js";
import { registerAgentHandlers } from "./agent/index.js";

export { createWebSocketServer } from "./websocket/index.js";
export { createRouter } from "./message/router.js";
export * from "./message/types.js";
export { registerAgentHandlers } from "./agent/index.js";

/**
 * 启动 RPC 服务
 */
export function startService(port: number): ReturnType<typeof createWebSocketServer> {
  const router = createRouter();

  // 注册 handlers
  registerAgentHandlers(router);

  // 创建 WebSocket 服务器
  const wss = createWebSocketServer({ port, router });

  return wss;
}