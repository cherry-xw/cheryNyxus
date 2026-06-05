import type { MiddlewareContext, MiddlewareHandler } from "./types";

/**
 * 中间件组合器（洋葱模型 + Generator yield）
 * 执行顺序：最外层 Enter → 内层 Enter → Core → 内层 Exit → 最外层 Exit
 * 单次执行，不处理重试（重试逻辑由 index.ts 的 loop 机制处理）
 * 泛型参数 T 表示 yield 的 chunk 类型
 */
export function compose<T = unknown>(
  handlers: MiddlewareHandler<T>[],
): (ctx: MiddlewareContext) => AsyncGenerator<T> {
  return async function* (ctx: MiddlewareContext): AsyncGenerator<T> {
    yield* executeChain(ctx, handlers, 0);
  };
}

/**
 * 执行中间件链片段
 */
async function* executeChain<T>(
  ctx: MiddlewareContext,
  handlers: MiddlewareHandler<T>[],
  startIndex: number,
): AsyncGenerator<T> {
  let index = startIndex;

  async function* next(): AsyncGenerator<T> {
    if (index < handlers.length) {
      const handler = handlers[index];
      if (handler) {
        index++;
        try {
          yield* handler(ctx, next);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`[compose] handler at index ${index - 1} threw: ${message}`, { cause: err });
        }
      }
    }
  }

  yield* next();
}
