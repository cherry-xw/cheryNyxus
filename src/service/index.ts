import { createRouter } from "./message/router.js";
import { createWebSocketServer } from "./websocket/index.js";
import { registerBrainHandlers } from "./brain/list.js";
import { registerBrainSetHandlers } from "./brain/set.js";
import { registerSenseHandlers } from "./sense/list.js";
import { registerSenseSetHandlers } from "./sense/set.js";
import { registerChatHandlers } from "./chat/send.js";
import { registerChatManageHandlers } from "./chat/handler.js";
import { registerResumeHandlers } from "./chat/resume.js";

export { createWebSocketServer } from "./websocket/index.js";
export { createRouter } from "./message/router.js";
export * from "./message/types.js";

/**
 * 启动 RPC 服务
 */
export function startService(port: number): ReturnType<typeof createWebSocketServer> {
  const router = createRouter();

  // 注册 handlers
  registerBrainHandlers(router);
  registerBrainSetHandlers(router);
  registerSenseHandlers(router);
  registerSenseSetHandlers(router);
  registerChatHandlers(router);
  registerChatManageHandlers(router);
  registerResumeHandlers(router);

  // 创建 WebSocket 服务器
  const wss = createWebSocketServer({ port, router });

  return wss;
}
