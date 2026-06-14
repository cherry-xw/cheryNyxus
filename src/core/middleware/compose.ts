import type { MiddlewareContext, MiddlewareHandler } from "./types";

/**
 * 组合后的中间件：run 启动洋葱链，abort 直接退出 generator。
 */
export interface ComposedMiddleware<T = unknown> {
  run(ctx: MiddlewareContext): AsyncGenerator<T>;
  /**
   * 注入错误到 generator 当前挂起点（senseMiddleware 的 await approval），
   * 其 catch 捕获 → throw 传播退出整个 generator（不继续 next）。
   * 用于 chat.abort 等场景：core 层自主退出，不依赖 service 层 approvalManager。
   */
  abort(): void;
}

/**
 * 中间件组合器（洋葱模型 + Generator yield）
 * 执行顺序：最外层 Enter → 内层 Enter → Core → 内层 Exit → 最外层 Exit
 * 单次执行，不处理重试（重试逻辑由 index.ts 的 loop 机制处理）
 * 泛型参数 T 表示 yield 的 chunk 类型
 *
 * 返回 ComposedMiddleware：run 每次创建新 generator 并记录引用；abort 对当前
 * generator 调 .throw() 注入错误，挂起的 await 抛错被 senseMiddleware catch 捕获，
 * 重新 throw 传播退出整个链（message "approval aborted" 与 tool.ts catch /
 * handleChatSend 静默判断一致）。
 */
export function compose<T = unknown>(
  handlers: MiddlewareHandler<T>[],
): ComposedMiddleware<T> {
  let currentGen: AsyncGenerator<T> | null = null;

  return {
    run(ctx: MiddlewareContext): AsyncGenerator<T> {
      currentGen = (async function* (): AsyncGenerator<T> {
        yield* executeChain(ctx, handlers, 0);
      })();
      return currentGen;
    },
    abort(): void {
      if (!currentGen) return;
      const gen = currentGen;
      currentGen = null;
      // .throw 注入到挂起的 await → senseMiddleware catch → throw 传播退出。
      // 返回 Promise：generator 已 done / 无挂起点 / throw 最终传播为 reject 时忽略。
      gen.throw(new Error("approval aborted")).catch(() => {
        // generator 已终止或无挂起点：忽略
      });
    },
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
