import {
  type Request,
  type Response,
  type Chunk,
  type Notification,
  type RequestData,
  type ResponseData,
  createResponse,
  createError,
  ErrorCode,
  isRequest,
  isResponse,
} from "./types.js";
import { isAsyncGenerator } from "@/utils/generator.js";
import { logger } from "@/utils/logger/index.js";

export class RpcHandlerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcHandlerError";
  }
}

// ========== Handler 类型 ==========

/**
 * Handler 上下文
 */
export interface HandlerContext {
  requestId?: string;
  connectionId: string;
  sendChunk: (chunk: Chunk) => void;
  sendNotification: (notification: Notification) => void;
}

/**
 * Handler 函数类型
 */
export type HandlerFn<TData = RequestData, TResult = ResponseData> = (
  ctx: HandlerContext,
  data: TData,
) => Promise<TResult> | AsyncGenerator<Chunk | Notification, TResult, unknown>;

/**
 * Handler 定义
 */
interface HandlerDefinition {
  method: string;
  handler: HandlerFn<RequestData, ResponseData>;
  streaming: boolean;
}

// ========== Router ==========

/**
 * RPC 路由器
 */
export class RpcRouter {
  private handlers = new Map<string, HandlerDefinition>();

  /**
   * 注册 handler
   */
  register<TData, TResult>(
    method: string,
    handler: HandlerFn<TData, TResult>,
    streaming = false,
  ): void {
    this.handlers.set(method, { method, handler: handler as unknown as HandlerFn<RequestData, ResponseData>, streaming });
  }

  /**
   * 处理请求
   */
  async handle(
    request: Request,
    ctx: HandlerContext,
  ): Promise<Response | AsyncGenerator<Chunk | Notification, Response, unknown>> {
    const definition = this.handlers.get(request.method);
    if (!definition) {
      return createResponse(
        request.id,
        false,
        undefined,
        createError(ErrorCode.METHOD_NOT_FOUND, `Method "${request.method}" not found`),
      );
    }

    try {
      const result = definition.handler(ctx, request.params);

      // 判断是否为 Generator
      if (isAsyncGenerator(result)) {
        return this.wrapStreamingHandler(result as AsyncGenerator<Chunk | Notification, unknown, unknown>, request.id);
      }

      // 普通 Promise
      const data = await result;
      if (isResponse(data)) {
        return data;
      }
      return createResponse(request.id, true, data);
    } catch (err) {
      const error = toRpcError(err);
      logger.error(`[Router] handler 执行失败 (${request.method}): ${error.message}`);
      return createResponse(
        request.id,
        false,
        undefined,
        createError(error.code, error.message),
      );
    }
  }

  /**
   * 包装流式 handler，确保最终返回 Response
   */
  private async *wrapStreamingHandler(
    generator: AsyncGenerator<Chunk | Notification, unknown, unknown>,
    requestId: string,
  ): AsyncGenerator<Chunk | Notification, Response, unknown> {
    try {
      while (true) {
        const iter = await generator.next();
        if (iter.done) {
          if (isResponse(iter.value)) {
            return normalizeResponseRequestId(iter.value, requestId);
          }
          return createResponse(requestId, true, iter.value as ResponseData | undefined);
        }
        yield iter.value;
      }
    } catch (err) {
      const error = toRpcError(err);
      logger.error(`[Router] 流式 handler 执行失败 (${requestId}): ${error.message}`);
      yield {
        kind: "notification",
        type: "error",
        requestId,
        data: { message: error.message },
      } as Notification;
      return createResponse(
        requestId,
        false,
        undefined,
        createError(error.code, error.message),
      );
    }
  }

  /**
   * 获取已注册的方法列表
   */
  getMethods(): string[] {
    return Array.from(this.handlers.keys());
  }
}

/**
 * 判断是否为 Request
 */
export function isRpcRequest(msg: unknown): msg is Request {
  return isRequest(msg);
}

/**
 * 创建路由器实例
 */
export function createRouter(): RpcRouter {
  return new RpcRouter();
}

function toRpcError(err: unknown): { code: string; message: string } {
  if (err instanceof RpcHandlerError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: ErrorCode.INTERNAL, message: err.message };
  }
  return { code: ErrorCode.INTERNAL, message: String(err) };
}

function normalizeResponseRequestId(response: Response, requestId: string): Response {
  if (response.requestId === requestId) {
    return response;
  }
  return createResponse(requestId, response.success, response.data, response.error);
}
