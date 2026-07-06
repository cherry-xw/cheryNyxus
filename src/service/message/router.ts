import {
  type Request,
  type Response,
  type Chunk,
  type Notification,
  type RequestData,
  type ResponseData,
  type Method,
  createResponse,
  createError,
  ErrorCode,
  isResponse,
} from "./types.js";
import { requestSchemaFor } from "./schemas.js";
import { isAsyncGenerator } from "@/utils/generator.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";
import type { Logger } from "@/utils/logger/types.js";

// ========== Handler 类型 ==========

/**
 * Handler 上下文
 */
export interface HandlerContext {
  requestId?: string;
  connectionId: string;
  /** 作用域 Logger 句柄（= 全局 logger，读 ALS 取 scope） */
  log: Logger;
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
    method: Method,
    handler: HandlerFn<TData, TResult>,
  ): void {
    this.handlers.set(method, { method, handler: handler as unknown as HandlerFn<RequestData, ResponseData> });
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

    // P1-5：zod 校验 params，非法 → INVALID_PARAMS（替代旧 handler 内 `as` 强转静默穿透）。
    // schema 存在性与 handler 同步注册（requestSchemas 覆盖全部 Method）。
    const schema = requestSchemaFor(request.method);
    if (!schema) {
      return createResponse(
        request.id,
        false,
        undefined,
        createError(ErrorCode.INTERNAL, `No schema registered for method ${request.method}`),
      );
    }
    const parsed = schema.safeParse(request.params);
    if (!parsed.success) {
      logger.event(
        "req.invalid_params",
        { method: request.method, error: parsed.error.message },
        LogLevel.warn,
      );
      return createResponse(
        request.id,
        false,
        undefined,
        createError(ErrorCode.INVALID_PARAMS, parsed.error.message),
      );
    }

    try {
      const result = definition.handler(ctx, parsed.data as RequestData);

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
      logger.event("req.handler.error", { method: request.method, message: error.message }, LogLevel.error);
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
      logger.event("req.stream.error", { requestId, message: error.message }, LogLevel.error);
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
}

/**
 * 创建路由器实例
 */
export function createRouter(): RpcRouter {
  return new RpcRouter();
}

function toRpcError(err: unknown): { code: string; message: string } {
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
