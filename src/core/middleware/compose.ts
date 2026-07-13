import type { MiddlewareContext, MiddlewareHandler } from "./types";
import { AgentAbortError, isAgentAbortError } from "./errors.js";
import { newTracingId } from "@/utils/error.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";

/**
 * 识别"已合规"错误：message 末尾已有 8 hex tracingId
 * （见 [docs/error-conventions.md](../../docs/error-conventions.md) — throwUserFacing 输出）。
 * 合规错误在 compose catch 中原样上浮，不加大段前缀污染用户面。
 *
 * 注意正则字面量写法：`\[[0-9a-f]{8}\]$` —— 第一个 `\[` 在字符类 `[` 开始**之前**，
 * 用来转义字面 `[`；之后的 `[0-9a-f]` 才是真正的字符类（范围 0-9 / a-f）。
 * 写成 `\[0-9a-f]{8}\]$` 会把 `0-9a-f]` 当作字面 6 字符序列（`-` 在字符类外不构成范围），
 * 等价于匹配 8 次重复 `0-9a-f]`，永远 false。
 */
const COMPLIANT_TRACE_PATTERN = /\[[0-9a-f]{8}\]$/;

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
 * 重新 throw 传播退出整个链（AgentAbortError 与 tool.ts catch /
 * handleChatSend 静默判断一致；compose catch 对其豁免包装，原样上浮）。
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
      // .throw 注入 AgentAbortError 到挂起的 await → senseMiddleware catch → throw 传播退出。
      // 返回 Promise：generator 已 done / 无挂起点 / throw 最终传播为 reject 时忽略。
      gen.throw(new AgentAbortError()).catch(() => {
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
  index: number,
): AsyncGenerator<T> {
  const handler = handlers[index];
  if (!handler) return;

  try {
    // `next` is a factory, not a shared cursor.  Retry middleware invokes it
    // once per attempt; a shared monotonic index used to turn later attempts
    // into an empty generator.  Each invocation therefore gets a fresh
    // downstream pipeline beginning at index + 1.
    yield* handler(ctx, () => executeChain(ctx, handlers, index + 1));
  } catch (err) {
    // AgentAbortError 是控制流信号（chat.abort/审批 reject），非可调试故障：
    // 原样上浮，不包装前缀，保证下游 retry/send 的 isAgentAbortError 判定命中。
    if (isAgentAbortError(err)) throw err;

    const message = err instanceof Error ? err.message : String(err);

    // 合规错误：message 末尾已有 8hex tracingId（throwUserFacing 输出）
    // → 原样上浮，不加大段前缀污染用户面（[docs/error-conventions.md](../../docs/error-conventions.md)）
    if (COMPLIANT_TRACE_PATTERN.test(message)) {
      throw err;
    }

    // 未合规错误：第三方库裸抛（OpenAI SDK 401 / 网络 ECONNREFUSED / 业务未规范化），
    // compose 层无业务上下文（不知 model/senseName）→ 用户面只能给"内部错误 + tracingId"，
    // 详细（含 handlerIndex + 原 error + stack）落 logger 供开发者还原
    const tracingId = newTracingId();
    logger.event(
      "compose.unhandled",
      {
        tracingId,
        handlerIndex: index,
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      },
      LogLevel.error,
    );
    throw new Error(`内部错误，请用 [${tracingId}] 反馈给开发`, { cause: err });
  }
}
