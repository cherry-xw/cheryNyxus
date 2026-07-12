import { createRouter } from "./message/router.js";
import { createWebSocketServer } from "./websocket/index.js";
import { createHttpServer } from "./http/index.js";
import { registerBrainHandlers } from "./brain/list.js";
import { registerSenseHandlers } from "./sense/list.js";
import { registerPromptHandlers } from "./prompt/list.js";
import { registerRuntimeSetHandlers } from "./runtime/set.js";
import { registerSessionRuntimeHandlers } from "./runtime/session.js";
import { registerChatHandlers } from "./chat/send.js";
import { rebuildWaitedChildren } from "./chat/wake.js";
import { registerChatManageHandlers } from "./chat/handler.js";
import { registerBashHandlers } from "./bash/handler.js";
import { registerMcpHandlers } from "./mcp/handler.js";
import { registerRole } from "./subagent/index.js";
import { registerConfigHandlers } from "./config/handler.js";
import { registerUtilsHandlers } from "./utils/handler.js";
import { randomBytes } from "node:crypto";
import { OAuth2Auth, type OAuth2Config } from "./auth/index.js";

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
  /** Allows tests/integrators to supply a stable local session capability. */
  sessionToken?: string;
  /** Network binding. Defaults to loopback; set explicitly for an intranet deployment. */
  host?: string;
  auth?: OAuth2Config;
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
  registerPromptHandlers(router);
  registerRuntimeSetHandlers(router);
  registerSessionRuntimeHandlers(router);
  registerChatHandlers(router);
  registerChatManageHandlers(router);
  registerBashHandlers(router);
  registerMcpHandlers(router);
  // CP3 + T9：spawn broadcaster 注入 + wait=true 看门狗超时回调（spawn_role sense 用）。
  // 历史 subagent.result RPC 已废弃（wait=true 改后端注入唤醒，无需前端回传）。
  registerRole();
  // T9.10：从持久化 metadata 重建 wait=true 唤醒链（finished 子补唤 / interrupted 子重建链+看门狗）。
  // 须在 registerRole（注入 asyncWakeHandler）之后，使重建的看门狗超时可触发 wakeParent。
  void rebuildWaitedChildren();
  // Config 设置面板：读写 .chery/config.yaml（除 server 段，重启生效）
  registerConfigHandlers(router);
  // Utils 工具：独立信息查询（utils.models 等，不依赖 chat/brain 运行时）
  registerUtilsHandlers(router);

  // 创建 WebSocket 服务器
  const auth = new OAuth2Auth(options.auth);
  const sessionToken = options.sessionToken ?? randomBytes(32).toString("base64url");
  const allowedOrigins = [
    `http://127.0.0.1:${options.webPort}`,
    `http://localhost:${options.webPort}`,
    // Vite development server (the socket is proxied, but browser Origin remains 5173).
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "file://",
  ];
  const wss = createWebSocketServer({
    port: options.port,
    host: options.host ?? "127.0.0.1",
    router,
    authToken: sessionToken,
    allowedOrigins,
    auth,
  });

  // 创建 HTTP 服务器（静态 serve + /api/config）
  const httpServer = createHttpServer({
    webPort: options.webPort,
    staticDir: options.staticDir,
    sessionToken,
    host: options.host ?? "127.0.0.1",
    auth,
  });

  return { wss, httpServer };
}
