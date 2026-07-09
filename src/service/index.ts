import { createRouter } from "./message/router.js";
import { createWebSocketServer } from "./websocket/index.js";
import { createHttpServer } from "./http/index.js";
import { registerBrainHandlers } from "./brain/list.js";
import { registerSenseHandlers } from "./sense/list.js";
import { registerRuntimeSetHandlers } from "./runtime/set.js";
import { registerChatHandlers } from "./chat/send.js";
import { registerChatManageHandlers } from "./chat/handler.js";
import { registerBashHandlers } from "./bash/handler.js";
import { registerMcpHandlers } from "./mcp/handler.js";
import { registerSubagent } from "./subagent/index.js";
import { registerConfigHandlers } from "./config/handler.js";

export { createWebSocketServer } from "./websocket/index.js";
export { createHttpServer } from "./http/index.js";
export { createRouter } from "./message/router.js";
export * from "./message/types.js";

export interface StartServiceOptions {
  /** WebSocket 服务端口（config.server.port） */
  port: number;
  /** HTTP 静态服务端口（config.server.web_port） */
  webPort: number;
  /** 前端静态产物目录（web/dist/） */
  staticDir: string;
}

export interface ServiceHandle {
  wss: ReturnType<typeof createWebSocketServer>;
  httpServer: ReturnType<typeof createHttpServer>;
}

/**
 * 启动 RPC 服务（WebSocket）+ HTTP 静态服务
 */
export function startService(options: StartServiceOptions): ServiceHandle {
  const router = createRouter();

  // 注册 handlers
  registerBrainHandlers(router);
  registerSenseHandlers(router);
  registerRuntimeSetHandlers(router);
  registerChatHandlers(router);
  registerChatManageHandlers(router);
  registerBashHandlers(router);
  registerMcpHandlers(router);
  // CP3：subagent.result RPC handler + spawn broadcaster 注入（spawn_subagent sense 用）
  registerSubagent(router);
  // Config 设置面板：读写 .chery/config.yaml（除 server 段，重启生效）
  registerConfigHandlers(router);

  // 创建 WebSocket 服务器
  const wss = createWebSocketServer({ port: options.port, router });

  // 创建 HTTP 服务器（静态 serve + /api/config）
  const httpServer = createHttpServer({ webPort: options.webPort, staticDir: options.staticDir });

  return { wss, httpServer };
}
