import { randomUUID } from 'node:crypto'
import { logger } from './logger/index.js'
import { LogLevel } from './logger/types.js'

/**
 * 错误信息分层工具（见 [docs/error-conventions.md](../../docs/error-conventions.md)）。
 *
 * 提供 `newTracingId` / `throwUserFacing` / `ClassifiedError` / `classifyError` / `friendlyMessage`：
 * - `newTracingId`：8 位 hex（UUID v4 前 8 位），用户面 + 日志面抄录用
 * - `throwUserFacing`：抛**终态**用户面错误（缺 key/model 等，不重试），tracingId 前置
 * - `ClassifiedError`：抛**可重试**错误，携带 category/source/userMessage，供 retry 判重试、表层出口取友好文案
 * - `classifyError`：按 message 关键词分类（retry 与 compose 兜底共用）
 * - `friendlyMessage`：按 category+source 查带来源直观文案
 *
 * **何时使用**：任何抛错会到达用户面（前端 toast / WS 错误帧 / HTTP body / 控制台 warn）的路径。
 * **何时不使用**：内部 helper 错误（不外传）、开发期 throw new Error("TODO") 占位、测试断言。
 */

// ========== 分类与来源 ==========

export type ErrorCategory = 'auth' | 'network' | 'provider' | 'timeout' | 'validation' | 'unknown'

/** 错误来源（决定友好文案的主语，见 friendlyMessage） */
export type ErrorSource = 'brain' | 'sense' | 'media' | 'mcp' | 'chat' | 'system' | 'hook'

// ========== tracingId ==========

/**
 * 8 位 hex tracingId：UUID v4 前 8 位，理论 16^8 ≈ 42 亿组合，足够全局唯一。
 *
 * 用户面消息**前置**此 id，开发者凭 id 全文检索日志还原上下文。
 * 检索示例（见 [error-conventions.md 日志检索约定](../../docs/error-conventions.md#日志检索约定)）：
 *   grep "1c538629" .chery/logs/
 *   grep -r '"tracingId":"1c538629"' .chery/
 */
export function newTracingId(): string {
  return randomUUID().slice(0, 8)
}

/**
 * 识别"已合规"错误：message **开头**已有 `[8hex] ` 前缀（throwUserFacing / ClassifiedError 出口产出）。
 * 合规错误在 compose catch / streamMapper 中原样上浮，不再二次包装或追加 tracingId。
 */
export const COMPLIANT_TRACE_PATTERN = /^\[[0-9a-f]{8}\] /

// ========== ClassifiedError ==========

/**
 * 可重试/带分类的用户面错误。
 *
 * 抛错点已知分类与来源时使用（如 provider 捕 SDK/fetch 错误）：
 * - retry 中间件读 `category` 判重试（不依赖 message 关键词）；
 * - 表层出口（compose catch / streamMapper）优先取 `userMessage` 作用户面，tracingId 由出口前置；
 * - `message`（super.message）保留原始技术文本，供日志还原。
 *
 * 终态错误（缺 key/model，不重试）仍用 `throwUserFacing`。
 */
export class ClassifiedError extends Error {
  readonly category: ErrorCategory
  readonly source: ErrorSource
  readonly userMessage: string
  constructor(opts: {
    message: string
    userMessage: string
    category: ErrorCategory
    source: ErrorSource
    cause?: unknown
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'ClassifiedError'
    this.category = opts.category
    this.source = opts.source
    this.userMessage = opts.userMessage
  }
}

// ========== classifyError ==========

/**
 * 按错误 message 关键词分类（retry 与 compose 兜底共用）。
 *
 * auth（401/403）优先级最高：避免 "401 invalid access token" 因含 "invalid" 被误判为 validation。
 * 优先用 `ClassifiedError.category`（抛错点已知），本函数仅在无 ClassifiedError 时兜底。
 */
export function classifyError(error: unknown): ErrorCategory {
  if (error instanceof ClassifiedError) return error.category
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('invalid access token') ||
      msg.includes('invalid api key')
    ) {
      return 'auth'
    }
    if (
      msg.includes('network') ||
      msg.includes('connection') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('fetch failed')
    ) {
      return 'network'
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return 'timeout'
    }
    if (msg.includes('validation') || msg.includes('invalid') || msg.includes('schema')) {
      return 'validation'
    }
    if (msg.includes('api') || msg.includes('rate limit') || msg.includes('provider')) {
      return 'provider'
    }
  }
  return 'unknown'
}

// ========== friendlyMessage ==========

/** 来源 → 中文主语 */
const SOURCE_LABEL: Record<ErrorSource, string> = {
  brain: '脑子',
  sense: '感官',
  media: '媒体',
  mcp: '扩展工具',
  chat: '会话',
  system: '系统',
  hook: '钩子',
}

/**
 * 按 category + source 查带来源的直观文案（不含 tracingId，由出口前置）。
 * 通用兜底保证带来源主语（"X 出了点小问题"），不裸"出了点小问题"。
 */
export function friendlyMessage(category: ErrorCategory, source: ErrorSource): string {
  const s = SOURCE_LABEL[source]
  switch (category) {
    case 'network':
      return `${s}连不上了`
    case 'auth':
      return source === 'brain' ? '大脑的钥匙不对，请在设置里检查 key' : `${s}的钥匙不对`
    case 'timeout':
      return source === 'brain'
        ? '脑子反应太慢了'
        : source === 'system'
          ? '系统等太久了'
          : `${s}反应太慢了`
    case 'provider':
      return source === 'brain'
        ? '脑子忙不过来了，稍后再试'
        : source === 'system'
          ? '系统出了点状况'
          : `${s}出了点状况`
    case 'validation':
      return source === 'system' ? '系统没听懂这个请求' : `${s}没听懂这个请求`
    case 'unknown':
    default:
      return `${s}出了点小问题`
  }
}

// ========== throwUserFacing ==========

/**
 * 抛**终态**用户面错误：message 短直观，tracingId **前置**，日志面含完整上下文。
 *
 * 仅用于终态配置错误（缺 key/model、参数非法等，本就不重试）。
 * 可重试错误（网络/超时/provider）用 `ClassifiedError`，由表层出口前置 tracingId。
 *
 * @param scope        logger event type（模块前缀，如 "llm.key.missing" / "compose.handler"）
 * @param userMessage  用户面 message（不含 tracingId，函数自动前置 `[tracingId] `）
 * @param context      日志面额外字段（model/url/envName/reason/attempt 等）
 * @throws Error（never return）
 */
export function throwUserFacing(
  scope: string,
  userMessage: string,
  context: Record<string, unknown> = {},
): never {
  const tracingId = newTracingId()
  logger.event(scope, { tracingId, ...context }, LogLevel.error)
  throw new Error(`[${tracingId}] ${userMessage}`)
}
