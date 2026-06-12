import { WebSocketServer, WebSocket } from "ws";
import {
  RpcRouter,
  createResponse,
  createError,
  ErrorCode,
  isRpcRequest,
  type Request,
  type Chunk,
  type Notification,
} from "../message/index.js";
import { connectionManager, type ConnectionState } from "./connection.js";
import { transport } from "./transport.js";
import { isAsyncGenerator } from "@/utils/generator.js";
import { logger } from "@/utils/logger/index.js";

/**
 * WebSocket 服务器配置
 */
interface WebSocketServerConfig {
  port: number;
  router: RpcRouter;
}

/**
 * 创建 WebSocket 服务器
 */
export function createWebSocketServer(config: WebSocketServerConfig): WebSocketServer {
  const { port, router } = config;
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    const state = connectionManager.create(ws);
    logger.info(`WebSocket 连接建立: ${state.id}`);

    ws.on("message", async (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      try {
        await handleMessage(ws, state, buffer, router);
      } catch (err) {
        const error = err as Error;
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
      logger.info(`WebSocket 连接关闭: ${state.id}`);
      await connectionManager.close(ws);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket 错误: ${state.id}`, err.message);
    });
  });

  logger.info(`WebSocket 服务启动，端口: ${port}`);
  return wss;
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

  if (isRpcRequest(raw)) {
    await handleRequest(ws, state, raw, router);
  } else {
    sendError(ws, "未知消息类型");
  }
}

/**
 * 处理 Request
 */
async function handleRequest(
  ws: WebSocket,
  state: ConnectionState,
  request: Request,
  router: RpcRouter,
): Promise<void> {
  logger.info(`处理请求: ${request.method}, id=${request.id}, connectionId=${state.id}`);

  connectionManager.addPendingRequest(ws, request.id);

  // 创建 handler context
  const ctx = {
    requestId: request.id,
    connectionId: state.id,
    sendChunk: (chunk: Chunk) => {
      ws.send(transport.encode(chunk));
    },
    sendNotification: (notification: Notification) => {
      ws.send(transport.encode(notification));
    },
  };

  // 执行 handler
  const result = await router.handle(request, ctx);

  // 处理结果
  if (isAsyncGenerator(result)) {
    connectionManager.setRequestGenerator(ws, request.id, result);

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
            logger.info(`审批超时，释放资源: connectionId=${state.id}`);
            ws.send(transport.serializeMessage(
              createResponse(request.id, false, undefined, createError(ErrorCode.TIMEOUT, "Approval timeout - chat ended")),
            ));
            await connectionManager.close(ws);
          });
        }
        ws.send(transport.encode(item));
        continue;
      }

      // Chunk 消息
      ws.send(transport.encode(item));
    }
  } else {
    ws.send(transport.serializeMessage(result));
  }

  // 清理
  connectionManager.clearApprovalTimeout(ws, request.id);
  connectionManager.removePendingRequest(ws, request.id);
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

export { connectionManager };
