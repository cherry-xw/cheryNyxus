import type { MiddlewareContext, MiddlewareHandler, MiddlewareChunk } from "./types";
import { RetryState } from "./types";

/**
 * 中间件组合器（洋葱模型 + Generator yield + 回退支持）
 * 执行顺序：最外层 Enter → 内层 Enter → Core → 内层 Exit → 最外层 Exit
 *
 * 回退机制：检查 ctx.retryState，若需回退则重新从指定中间件执行
 */
export function compose(
  handlers: MiddlewareHandler[],
): (ctx: MiddlewareContext) => AsyncGenerator<MiddlewareChunk> {
  return async function* (ctx: MiddlewareContext): AsyncGenerator<MiddlewareChunk> {
    // 初始化回退状态
    ctx.state.retryState = RetryState.none;

    let startIndex = 0;
    let executionCount = 0;
    const maxRetries = 10; // 防止无限循环

    while (executionCount < maxRetries) {
      executionCount++;

      // 执行中间件链
      yield* executeChain(ctx, handlers, startIndex);

      // 使用局部变量获取状态，避免控制流分析问题
      const currentState = ctx.state.retryState as RetryState;
      if (currentState === RetryState.retryMessage) {
        // 回退到 message 入口（索引 0）
        // 不重置 retryState，让 message 检查后自行重置
        startIndex = 0;
        continue;
      }

      // 无需回退，退出循环
      break;
    }
  };
}

/**
 * 执行中间件链片段
 */
async function* executeChain(
  ctx: MiddlewareContext,
  handlers: MiddlewareHandler[],
  startIndex: number,
): AsyncGenerator<MiddlewareChunk> {
  let index = startIndex;

  async function* next(): AsyncGenerator<MiddlewareChunk> {
    if (index < handlers.length) {
      const handler = handlers[index];
      if (handler) {
        index++;
        yield* handler(ctx, next);
      }
    }
  }

  yield* next();
}
