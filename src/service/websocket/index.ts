import { WebSocketServer, WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import {
  RpcRouter,
  createResponse,
  createError,
  ErrorCode,
  isRequest,
  type Request,
} from "../message/index.js";
import { connectionManager, type ConnectionState } from "./connection.js";
import { transport } from "./transport.js";
import { isAsyncGenerator } from "@/utils/generator.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";
import { OAuth2Auth } from "../auth/index.js";

/**
 * WebSocket 服务器配置
 */
interface WebSocketServerConfig {
  port: number;
  router: RpcRouter;
  /** Binding is supplied by the service entrypoint. */
  host?: string;
  /** Per-process capability, distributed only through the local HTTP/IPC bootstrap. */
  authToken?: string;
  /** Browser origins allowed to use an authenticated control-plane socket. */
  allowedOrigins?: readonly string[];
  /** Cookie-session authentication used for intranet OAuth2 deployments. */
  auth?: OAuth2Auth;
}

/**
 * 创建 WebSocket 服务器
 */
export function createWebSocketServer(config: WebSocketServerConfig): WebSocketServer {
  const { port, router, host, authToken, allowedOrigins = [], auth } = config;
  const wss = new WebSocketServer({
    port,
    ...(host ? { host } : {}),
    verifyClient: authToken || auth?.enabled
      ? (info, done) => {
          const origin = info.origin;
          if (!origin || !(auth?.isTrustedOrigin(origin, info.req) || allowedOrigins.includes(origin))) {
            done(false, 403, "WebSocket origin is not allowed");
            return;
          }
          if (auth?.enabled) {
            if (!auth.getUser(info.req)) done(false, 401, "WebSocket authentication required");
            else done(true);
            return;
          }
          const token = new URL(info.req.url ?? "/", "ws://localhost").searchParams.get("token") ?? "";
          if (!constantTimeTokenEqual(token, authToken!)) {
            done(false, 401, "WebSocket authentication failed");
            return;
          }
          done(true);
        }
      : undefined,
  });

  wss.on("connection", (ws) => {
    const state = connectionManager.create(ws);
    logger.run({ connectionId: state.id }, () => logger.event("conn.open"));

    ws.on("message", async (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      try {
        await handleMessage(ws, state, buffer, router);
      } catch (err) {
        const error = err as Error;
        logger.run({ connectionId: state.id }, () =>
          logger.event("req.error", { message: error.message }, LogLevel.error),
        );
        try {
          const raw = transport.parseMessage(buffer) as { id?: string };
          const requestId = raw.id || "";
          sendError(ws, error.message, requestId);
        } catch {
          sendError(ws, error.message);
        }
      }
    });

    ws.on("close", async () => {
      logger.run({ connectionId: state.id }, () => logger.event("conn.close"));
      await connectionManager.close(ws);
    });

    ws.on("error", (err) => {
      logger.run({ connectionId: state.id }, () =>
        logger.event("conn.error", { message: err.message }, LogLevel.error),
      );
    });
  });

  logger.info(`WebSocket 服务启动，地址: ${host ?? "default"}:${port}`);
  return wss;
}

function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 处理消息
 */
async function handleMessage(
  ws: WebSocket,
  state: ConnectionState,
  data: Buffer | string,
  router: RpcRouter,
): Promise<void> {
  const raw = transport.parseMessage(data);

  if (isRequest(raw)) {
    await handleRequest(ws, state, raw, router);
  } else {
    sendError(ws, "未知消息类型");
  }
}

/**
 * 处理 Request
 *
 * als.run 边界：整个请求处理（handler → agent → 中间件链 → observer/streamMapper）
 * 在此 scope 内执行。注意必须包「迭代」而非「创建」—— async generator 的 body 在
 * `.next()` 时运行，而最外层 `.next()` 就在本函数（普通 async 函数，非 generator）内，
 * 故整条流式链（含中间件深层日志）携带此 scope。跨审批挂起亦保持（本函数停在 await next）。
 */
async function handleRequest(
  ws: WebSocket,
  state: ConnectionState,
  request: Request,
  router: RpcRouter,
): Promise<void> {
  connectionManager.addPendingRequest(ws, request.id);

  // 创建 handler context
  const ctx = {
    requestId: request.id,
    connectionId: state.id,
    log: logger,
  };

  const scope = {
    connectionId: state.id,
    requestId: request.id,
    traceId: extractChatId(request.params),
  };

  // 执行 handler（在 scope 内迭代流式输出）
  await logger.run(scope, async () => {
    logger.event("req.start", { method: request.method });
    let outcome: { success: boolean; error?: string } | undefined;
    try {
      const result = await router.handle(request, ctx);

      // 处理结果
      if (isAsyncGenerator(result)) {
        while (true) {
          const iter = await result.next();
          if (iter.done) {
            // generator return value — 最终 Response
            if (iter.value) {
              ws.send(transport.serializeMessage(iter.value));
            }
            break;
          }
          const item = iter.value;

          // Notification 消息
          if (item.kind === "notification") {
            // interrupt 发出后启动审批超时
            if (item.type === "interrupt" && item.data && "approvalId" in item.data) {
              const approvalId = (item.data as { approvalId: string }).approvalId;
              connectionManager.setRequestApprovalId(ws, request.id, approvalId);
              connectionManager.startApprovalTimeout(ws, request.id, async () => {
                logger.event("approval.timeout", { approvalId });
                ws.send(transport.serializeMessage(
                  createResponse(request.id, false, undefined, createError(ErrorCode.TIMEOUT, "Approval timeout - chat ended")),
                ));
                await connectionManager.close(ws);
              });
            }
            // question_requested 发出后记录 questionId，断连 / abort 时调 questionManager.abort
            if (item.type === "question_requested" && item.data && "questionId" in item.data) {
              const questionId = (item.data as { questionId: string }).questionId;
              connectionManager.setRequestQuestionId(ws, request.id, questionId);
            }
            ws.send(transport.encode(item));
            continue;
          }

          // Chunk 消息
          ws.send(transport.encode(item));
        }
        outcome = { success: true };
      } else {
        ws.send(transport.serializeMessage(result));
        outcome = { success: (result as { success?: boolean }).success !== false };
      }
    } catch (e) {
      outcome = { success: false, error: (e as Error).message };
      throw e;
    } finally {
      logger.event("req.end", outcome);
    }
  });

  // 清理
  connectionManager.clearApprovalTimeout(ws, request.id);
  connectionManager.removePendingRequest(ws, request.id);
}

/**
 * 从 RPC params 提取 chatId（若存在且为 string）—— 用作 traceId（会话关联）。
 * 仅 chat.* / sense.approval 等携带 chatId 的方法会产生 traceId；其余方法 traceId 缺省。
 */
function extractChatId(params: unknown): string | undefined {
  if (params && typeof params === "object" && "chatId" in params) {
    const v = (params as Record<string, unknown>).chatId;
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * 发送错误
 */
function sendError(ws: WebSocket, message: string, requestId?: string): void {
  const response = createResponse(
    requestId || "",
    false,
    undefined,
    createError(ErrorCode.INTERNAL, message),
  );
  ws.send(transport.serializeMessage(response));
}

/**
 * 关闭所有 WebSocket 连接（应用关闭时调用）。
 * WebSocketServer.close() 只停止接受新连接，不关闭现有连接。
 * 需先调用本函数关闭所有客户端，再调用 wss.close()。
 */
export function closeAllConnections(wss: WebSocketServer): void {
  wss.clients.forEach((ws) => {
    // 移除所有监听器，避免关闭时触发 close/error 事件处理
    ws.removeAllListeners();
    ws.close();
  });
}
