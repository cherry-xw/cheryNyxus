import type { MiddlewareContext, MiddlewareHandler } from './types'
import { AgentAbortError, isAgentAbortError } from './errors.js'
import {
  COMPLIANT_TRACE_PATTERN,
  ClassifiedError,
  classifyError,
  friendlyMessage,
  throwUserFacing,
} from '@/utils/error.js'

/**
 * 组合后的中间件：run 启动洋葱链，abort 直接退出 generator。
 */
export interface ComposedMiddleware<T = unknown> {
  run(ctx: MiddlewareContext): AsyncGenerator<T>
  /**
   * 注入错误到 generator 当前挂起点（senseMiddleware 的 await approval），
   * 其 catch 捕获 → throw 传播退出整个 generator（不继续 next）。
   * 用于 chat.abort 等场景：core 层自主退出，不依赖 service 层 approvalManager。
   */
  abort(): void
}

/**
 * 中间件组合器（洋葱模型 + Generator yield）
 * 执行顺序：最外层 Enter → 内层 Enter → Core → 内层 Exit → 最外层 Exit
 * 单次执行，不处理重试（重试逻辑由 index.ts 的 loop 机制处理）
 * 泛型参数 T 表示 yield 的 chunk 类型
 *
 * 返回 ComposedMiddleware：run 每次创建新 generator 并记录引用；abort 对当前
 * generator 调 .throw() 注入错误，挂起的 await 抛错被 senseMiddleware catch 捕获，
 * 重新 throw 传播退出整个链（AgentAbortError 与 tool.ts catch /
 * handleChatSend 静默判断一致；compose catch 对其豁免包装，原样上浮）。
 */
export function compose<T = unknown>(handlers: MiddlewareHandler<T>[]): ComposedMiddleware<T> {
  let currentGen: AsyncGenerator<T> | null = null

  return {
    run(ctx: MiddlewareContext): AsyncGenerator<T> {
      currentGen = (async function* (): AsyncGenerator<T> {
        yield* executeChain(ctx, handlers, 0)
      })()
      return currentGen
    },
    abort(): void {
      if (!currentGen) return
      const gen = currentGen
      currentGen = null
      // .throw 注入 AgentAbortError 到挂起的 await → senseMiddleware catch → throw 传播退出。
      // 返回 Promise：generator 已 done / 无挂起点 / throw 最终传播为 reject 时忽略。
      gen.throw(new AgentAbortError()).catch(() => {
        // generator 已终止或无挂起点：忽略
      })
    },
  }
}

/**
 * 执行中间件链片段
 */
async function* executeChain<T>(
  ctx: MiddlewareContext,
  handlers: MiddlewareHandler<T>[],
  index: number,
): AsyncGenerator<T> {
  const handler = handlers[index]
  if (!handler) return

  try {
    // `next` is a factory, not a shared cursor.  Retry middleware invokes it
    // once per attempt; a shared monotonic index used to turn later attempts
    // into an empty generator.  Each invocation therefore gets a fresh
    // downstream pipeline beginning at index + 1.
    yield* handler(ctx, () => executeChain(ctx, handlers, index + 1))
  } catch (err) {
    // AgentAbortError 是控制流信号（chat.abort/审批 reject），非可调试故障：
    // 原样上浮，不包装前缀，保证下游 retry/send 的 isAgentAbortError 判定命中。
    if (isAgentAbortError(err)) throw err

    const message = err instanceof Error ? err.message : String(err)

    // 合规错误：message 开头已有 `[8hex] `（throwUserFacing / 上游 ClassifiedError 出口产出）
    // → 原样上浮，不二次包装（[docs/error-conventions.md](../../docs/error-conventions.md)）
    if (COMPLIANT_TRACE_PATTERN.test(message)) {
      throw err
    }

    // ClassifiedError（provider/sense 等已知分类来源的可重试错误）：取其友好文案作用户面。
    if (err instanceof ClassifiedError) {
      throwUserFacing('compose.unhandled', err.userMessage, {
        source: err.source,
        category: err.category,
        handlerIndex: index,
        originalError: message,
        stack: err.stack,
      })
    }

    // 未合规裸抛（第三方库裸抛 / 业务未规范化）：compose 层无业务上下文 →
    // 按 classifyError 兜底分类 + friendlyMessage(category, "系统") 出用户面，详细落 logger。
    const category = classifyError(err)
    throwUserFacing('compose.unhandled', friendlyMessage(category, 'system'), {
      category,
      handlerIndex: index,
      originalError: message,
      stack: err instanceof Error ? err.stack : undefined,
    })
  }
}
