import type { MiddlewareContext, MiddlewareHandler, MiddlewareChunk } from "./types";

/**
 * 中间件组合器（洋葱模型 + Generator yield）
 * 执行顺序：最外层 Enter → 内层 Enter → Core → 内层 Exit → 最外层 Exit
 * 单次执行，不处理重试（重试逻辑由 index.ts 的 loop 机制处理）
 */
export function compose(
  handlers: MiddlewareHandler[],
): (ctx: MiddlewareContext) => AsyncGenerator<MiddlewareChunk> {
  return async function* (ctx: MiddlewareContext): AsyncGenerator<MiddlewareChunk> {
    yield* executeChain(ctx, handlers, 0);
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
