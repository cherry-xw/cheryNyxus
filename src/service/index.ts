import { createRouter } from "./message/router.js";
import { createWebSocketServer } from "./websocket/index.js";
import { registerSoulHandlers } from "./soul/lifecycle.js";
import { registerChatHandlers } from "./chat/send.js";
import { registerChatManageHandlers } from "./chat/handler.js";

export { createWebSocketServer } from "./websocket/index.js";
export { createRouter } from "./message/router.js";
export * from "./message/types.js";

/**
 * 启动 RPC 服务
 */
export function startService(port: number): ReturnType<typeof createWebSocketServer> {
  const router = createRouter();

  // 注册 handlers
  registerSoulHandlers(router);
  registerChatHandlers(router);
  registerChatManageHandlers(router);

  // 创建 WebSocket 服务器
  const wss = createWebSocketServer({ port, router });

  return wss;
}