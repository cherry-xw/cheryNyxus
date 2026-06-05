import type { MiddlewareContext, LoopHandler, ErrorChunk } from "@/core/middleware/types";
import type { MiddlewareChunk } from "./index";

/**
 * 创建 agent 层循环策略
 * 包装单次 chain 执行，实现 tool 循环 + maxLoop 超限处理
 */
export function createLoopHandler(
  maxLoop: number = 30,
): LoopHandler<MiddlewareChunk> {
  return async function* loopHandler(
    ctx: MiddlewareContext,
    runChain: () => AsyncGenerator<MiddlewareChunk, void, unknown>,
  ): AsyncGenerator<MiddlewareChunk, void, unknown> {
    let times = 0;

    while (times < maxLoop) {
      times++;
      yield* runChain();

      // 检查 loop 停止条件（基于 ctx.session.messages）
      const messages = ctx.session.messages;
      if (!messages || messages.length === 0) {
        break;
      }

      const lastMessage = messages[messages.length - 1]!;

      // 1. 最后一条是 tool → 刚执行完工具 → 继续 loop（获取 LLM 新响应）
      if (lastMessage.role === "tool") {
        continue;
      }

      // 2. 最后一条是 assistant 且有 toolCalls → 工具调用完成 → 继续 loop（执行下一轮工具）
      if (lastMessage.role === "assistant" && lastMessage.toolCalls?.length) {
        continue;
      }

      // 3. 其他情况（assistant 无 toolCalls / user / system）→ 停止 loop
      break;
    }

    // 超过最大循环次数
    if (times >= maxLoop) {
      const errorChunk: ErrorChunk = {
        type: "error",
        errors: [
          {
            attempt: times,
            timestamp: Date.now(),
            message: `已达到最大循环次数限制 (${maxLoop})`,
            recoverable: false,
            category: "validation",
          },
        ],
      };
      yield errorChunk;
    }
  };
}
