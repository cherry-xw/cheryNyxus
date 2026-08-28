import {
  type Request,
  type Response,
  type Chunk,
  type Notification,
  type RequestData,
  type ResponseData,
  type ParamsOf,
  type ResultOf,
  type Method,
  createResponse,
  createError,
  ErrorCode,
  isResponse,
} from './types.js'
import { requestSchemaFor } from './schemas.js'
import { responseSchemaFor } from './responseSchemas.js'
import { ChunkEnvelopeSchema, NotificationEnvelopeSchema } from '@chery/protocol'
import { isAsyncGenerator } from '@/utils/generator.js'
import { newTracingId } from '@/utils/error.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import type { Logger } from '@/utils/logger/types.js'

// ========== Handler 类型 ==========

/**
 * Handler 上下文
 */
export interface HandlerContext {
  requestId?: string
  connectionId: string
  /** 作用域 Logger 句柄（= 全局 logger，读 ALS 取 scope） */
  log: Logger
}

/**
 * Handler 函数类型
 */
export type HandlerFn<M extends Method> = (
  ctx: HandlerContext,
  data: ParamsOf<M>,
) =>
  | Promise<ResultOf<M> | Response>
  | AsyncGenerator<Chunk | Notification, ResultOf<M> | Response, unknown>

/**
 * Handler 定义
 */
type ErasedHandlerFn = (
  ctx: HandlerContext,
  data: RequestData,
) =>
  | Promise<ResponseData | Response>
  | AsyncGenerator<Chunk | Notification, ResponseData | Response, unknown>

/** 动态 Map 的唯一类型擦除边界；注册入口仍由 Method 保证 params/result 对应。 */
interface HandlerDefinition {
  method: Method
  handler: ErasedHandlerFn
}

// ========== Router ==========

/**
 * RPC 路由器
 */
export class RpcRouter {
  private handlers = new Map<Method, HandlerDefinition>()

  /**
   * 注册 handler
   */
  register<M extends Method>(method: M, handler: HandlerFn<M>): void {
    if (this.handlers.has(method)) {
      throw new Error(`Duplicate RPC handler registration: ${method}`)
    }
    this.handlers.set(method, { method, handler: handler as unknown as ErasedHandlerFn })
  }

  /** Stable read-only snapshot used by startup assertions and contract tests. */
  registeredMethods(): readonly Method[] {
    return Object.freeze([...this.handlers.keys()].sort())
  }

  /**
   * 处理请求
   */
  async handle(
    request: Request,
    ctx: HandlerContext,
  ): Promise<Response | AsyncGenerator<Chunk | Notification, Response, unknown>> {
    const definition = this.handlers.get(request.method)
    if (!definition) {
      return createResponse(
        request.id,
        false,
        undefined,
        createError(
          ErrorCode.METHOD_NOT_FOUND,
          `[${newTracingId()}] 当前版本不支持此操作，请更新后重试`,
        ),
      )
    }

    // P1-5：zod 校验 params，非法 → INVALID_PARAMS（替代旧 handler 内 `as` 强转静默穿透）。
    // schema 存在性与 handler 同步注册（requestSchemas 覆盖全部 Method）。
    const schema = requestSchemaFor(request.method)
    if (!schema) {
      const tracingId = newTracingId()
      logger.event('req.no_schema', { tracingId, method: request.method }, LogLevel.error)
      return createResponse(
        request.id,
        false,
        undefined,
        createError(ErrorCode.INTERNAL, `[${tracingId}] 系统出了点小问题`),
      )
    }
    const parsed = schema.safeParse(request.params)
    if (!parsed.success) {
      // 两层错误（docs/error-conventions.md）：用户面一行中文 + 前置 tracingId；
      // 完整 Zod issues（path/code/expected/received 机读细节）走 logger.event 落盘，不进 message。
      const tracingId = newTracingId()
      logger.event(
        'req.invalid_params',
        { tracingId, method: request.method, issues: parsed.error.issues },
        LogLevel.warn,
      )
      return createResponse(
        request.id,
        false,
        undefined,
        createError(ErrorCode.INVALID_PARAMS, `[${tracingId}] 方言不通，没听懂这个请求`),
      )
    }

    try {
      const result = definition.handler(ctx, parsed.data)

      // 判断是否为 Generator
      if (isAsyncGenerator(result)) {
        return this.wrapStreamingHandler(
          result as AsyncGenerator<Chunk | Notification, unknown, unknown>,
          request.id,
          request.method,
        )
      }

      // 普通 Promise
      const data = await result
      if (isResponse(data)) {
        return this.validateResponse(request.method, normalizeResponseRequestId(data, request.id))
      }
      return this.validateResponse(request.method, createResponse(request.id, true, data))
    } catch (err) {
      const error = toRpcError(err)
      logger.event(
        'req.handler.error',
        { method: request.method, message: error.message },
        LogLevel.error,
      )
      return createResponse(request.id, false, undefined, createError(error.code, error.message))
    }
  }

  /**
   * 包装流式 handler，确保最终返回 Response
   */
  private async *wrapStreamingHandler(
    generator: AsyncGenerator<Chunk | Notification, unknown, unknown>,
    requestId: string,
    method: Method,
  ): AsyncGenerator<Chunk | Notification, Response, unknown> {
    try {
      while (true) {
        const iter = await generator.next()
        if (iter.done) {
          if (isResponse(iter.value)) {
            return this.validateResponse(
              method,
              normalizeResponseRequestId(iter.value, requestId),
            )
          }
          return this.validateResponse(
            method,
            createResponse(requestId, true, iter.value as ResponseData | undefined),
          )
        }
        // 统一 requestId：generator handler 可能用 chatId 作 chunk/notification 的 requestId
        // （如 handleChatGet 历史回放用 p.chatId），客户端按 RPC requestId 路由 → 统一覆盖为 request.id，
        // 消除 chat.get（chatId）与 chat.send（rid，streamMapper 注入）语义不一致。
        // streamMapper 注入的 rid / 各 notification requestId 覆盖后同为 rid，无副作用。
        // 注：spawn 的 role_created/destroyed 经 spawnBroker.broadcaster 直发 ws（不经 generator），不受此覆盖影响。
        const yielded = iter.value as Chunk | Notification
        yielded.requestId = requestId
        const eventSchema = yielded.kind === 'chunk' ? ChunkEnvelopeSchema : NotificationEnvelopeSchema
        const eventResult = eventSchema.safeParse(yielded)
        if (!eventResult.success) {
          const tracingId = newTracingId()
          logger.event(
            'res.invalid_event',
            { tracingId, method, issues: eventResult.error.issues },
            LogLevel.error,
          )
          return createResponse(
            requestId,
            false,
            undefined,
            createError(ErrorCode.INTERNAL, `[${tracingId}] 系统返回了无效事件`),
          )
        }
        yield yielded
      }
    } catch (err) {
      const error = toRpcError(err)
      logger.event('req.stream.error', { requestId, message: error.message }, LogLevel.error)
      return createResponse(requestId, false, undefined, createError(error.code, error.message))
    }
  }

  private validateResponse(method: Method, response: Response): Response {
    if (!response.success) return response
    const parsed = responseSchemaFor(method).safeParse(response.data)
    if (parsed.success) return response
    const tracingId = newTracingId()
    logger.event(
      'res.invalid_data',
      { tracingId, method, issues: parsed.error.issues },
      LogLevel.error,
    )
    return createResponse(
      response.requestId,
      false,
      undefined,
      createError(ErrorCode.INTERNAL, `[${tracingId}] 系统返回了无效数据`),
    )
  }
}

/**
 * 创建路由器实例
 */
export function createRouter(): RpcRouter {
  return new RpcRouter()
}

function toRpcError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    // 显式携带 ErrorCode 的错误（如 ensureChat 抛 RUNTIME_SELECTION_REQUIRED）按码透传；其余归 INTERNAL。
    const code = (err as Error & { code?: string }).code
    if (
      code &&
      Object.values(ErrorCode).includes(code as (typeof ErrorCode)[keyof typeof ErrorCode])
    ) {
      return { code, message: err.message }
    }
    return { code: ErrorCode.INTERNAL, message: err.message }
  }
  return { code: ErrorCode.INTERNAL, message: String(err) }
}

function normalizeResponseRequestId(response: Response, requestId: string): Response {
  if (response.requestId === requestId) {
    return response
  }
  return createResponse(requestId, response.success, response.data, response.error)
}
