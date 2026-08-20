import type { MiddlewareContext, ErrorChunk } from '@/core/middleware/types'
import { AgentAbortError, isAgentAbortError } from '@/core/middleware/errors.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { classifyError, ClassifiedError, type ErrorCategory } from '@/utils/error.js'

// ========== 配置常量 ==========
// 最多尝试 MAX_RETRIES 次（含首次）。重试间隔指数退避：第 attempt 次失败后等
// base * 2^(attempt-1) ms（1s/2s/4s/8s/16s）+ ±20% jitter，累计约 31s。
// jitter 让多 pet / 多会话同时失败时错峰重试，避免同步重试放大上游限流（429）。
const MAX_RETRIES = 5
const RETRY_BASE_DELAY_MS = 1000

/**
 * 判断错误是否可恢复（可重试）
 */
function isRecoverable(category: ErrorCategory): boolean {
  // network / timeout / provider 错误通常可重试
  // validation 不可重试（参数问题）
  // auth 不可重试（凭证失效，重试无意义；P1 加固：避免 token 失效重试 3x 浪费 6s）
  return category === 'network' || category === 'timeout' || category === 'provider'
}

// ========== 辅助函数 ==========
function createErrorInfo(attempt: number, error: unknown): ErrorChunk['errors'][number] {
  const category = classifyError(error)
  return {
    attempt,
    timestamp: Date.now(),
    message: error instanceof Error ? error.message : String(error),
    // ClassifiedError 携带友好文案与来源：表层出口（streamMapper）据此出用户面，tracingId 由出口前置。
    ...(error instanceof ClassifiedError
      ? { userMessage: error.userMessage, source: error.source }
      : {}),
    stack: error instanceof Error ? error.stack : undefined,
    recoverable: isRecoverable(category),
    category,
  }
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 指数退避等待：第 attempt 次失败后等 base * 2^(attempt-1) ms ±20% jitter。
 * attempt 从 1 起：1s → 2s → 4s → 8s → 16s（5 次尝试累计约 31s）。
 */
async function delayWithBackoff(attempt: number): Promise<void> {
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  await delay(Math.max(0, Math.round(base + jitter)))
}

// ========== Middleware 实现 ==========
/**
 * Retry Middleware
 * 职责：捕获 chat 调用错误，重试 MAX_RETRIES 次
 * 成功：透传所有 chunks
 * 失败：yield ErrorChunk 包含所有错误信息（含分类）
 */
export async function* retryMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<unknown>,
): AsyncGenerator<ErrorChunk | unknown> {
  const errors: ErrorChunk['errors'] = []

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // 快照本轮 chain 起始的 messages 长度：chat 流中途失败时，外层 checkpoint 已 append 半截 assistant message，
    // 重试前回滚到本轮起始状态，避免重复 append 污染历史（P0-5）。
    // 注：已 yield 的 StreamChunk 无法撤回（retry 固有表现），仅回滚内存 messages。
    // P1-1：snapshot 含本轮 checkpoint 已 push 的 user（checkpoint 先于 retry 执行），
    //   截断仅回滚半截 assistant，本轮 user 保留。resume 路径首轮 senseMiddleware skip chat 层，
    //   retry.next() 返回空不追加 → snapshot 截断无实质触发，安全。
    //   messages 类型可选但运行时由 init 赋 []，显式守卫消除 undefined（替代原 ?. 掩盖）。
    const messages = ctx.soul.messages
    if (!messages) throw new Error('soul.messages not initialized before retry')
    const snapshot = messages.length
    try {
      // 透传所有 chunks（chat 只 yield StreamChunk/StagedChunk）
      yield* next()
      return // 成功，结束
    } catch (error) {
      // provider 因 AbortSignal 抛出的网络错误不能落入 retry；watchdog 已终止此 run。
      if (ctx.pipeline?.isAbortRequested()) throw new AgentAbortError()
      // compose abort（chat.abort 注入的 AgentAbortError）：直接 re-throw 传播退出整个 generator，
      // 不重试、不转 ErrorChunk（保证 abort 在任意挂起点都"直接退出"，由 handleChatSend catch 静默）。
      if (isAgentAbortError(error)) {
        throw error
      }
      const errorInfo = createErrorInfo(attempt, error)
      errors.push(errorInfo)
      logger.event(
        'retry.attempt',
        {
          attempt,
          category: errorInfo.category,
          recoverable: errorInfo.recoverable,
          message: error instanceof Error ? error.message : String(error),
        },
        LogLevel.warn,
      )

      // 回滚本轮 checkpoint 已 append 的半截 message，恢复历史干净后再重试
      messages.length = snapshot

      // 非最后一次且可恢复：指数退避等待后继续
      if (attempt < MAX_RETRIES && errorInfo.recoverable) {
        await delayWithBackoff(attempt)
        continue
      }

      // 最后一次失败或不可恢复：yield ErrorChunk
      yield { type: 'error', errors }
      return
    }
  }
}
