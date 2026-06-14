import type { MiddlewareContext, LoopHandler, ErrorChunk, DoneChunk } from "@/core/middleware/types";
import type { MiddlewareChunk } from "./index";
import { logger } from "@/utils/logger/index.js";

/**
 * 创建 agent 层循环策略
 * 包装单次 chain 执行，实现 sense 循环 + maxLoop 超限处理
 */
export function createLoopHandler(
  maxLoop: number = 30,
): LoopHandler<MiddlewareChunk> {
  return async function* loopHandler(
    ctx: MiddlewareContext,
    runChain: () => AsyncGenerator<MiddlewareChunk, void, unknown>,
  ): AsyncGenerator<MiddlewareChunk, void, unknown> {
    let times = 0;
    let stopped = false;  // 区分 break（正常停止）vs while 条件耗尽（避免误报）

    logger.info("\n" + "▶".repeat(60));
    logger.info("[LOOP] Starting execution loop (max: " + maxLoop + ")");
    logger.info("▶".repeat(60) + "\n");

    while (times < maxLoop) {
      times++;

      logger.info("\n[LOOP] Iteration #" + times);
      logger.info("─".repeat(40));

      yield* runChain();

      // 检查 loop 停止条件（基于 ctx.soul.messages）
      const messages = ctx.soul.messages;
      if (!messages || messages.length === 0) {
        if (ctx.soul.userInputs.length > 0) {
          logger.info("[LOOP] Continue: residual userInputs after empty messages");
          continue;
        }
        logger.info("[LOOP] Stop: No messages");
        stopped = true;
        break;
      }

      const lastMessage = messages[messages.length - 1]!;

      // 1. 最后一条是 sense → 刚执行完感官 → 继续 loop（获取 LLM 新响应）
      if (lastMessage.role === "sense") {
        logger.info("[LOOP] Continue: Last message is 'sense'");
        logger.info("[LOOP] Sense content:", lastMessage.content?.slice(0, 100) || "(empty)");
        continue;
      }

      // 2. 最后一条是 assistant 且有 senseCalls → 感官调用完成 → 继续 loop（执行下一轮感官）
      if (lastMessage.role === "assistant" && lastMessage.senseCalls?.length) {
        logger.info("[LOOP] Continue: Assistant has senseCalls");
        logger.info("[LOOP] Sense calls:", lastMessage.senseCalls.map(sc => sc.name).join(", "));
        continue;
      }

      // 3. 其他情况（assistant 无 senseCall / user / system）→ 检查残留输入后再停止
      if (ctx.soul.userInputs.length > 0) {
        logger.info("[LOOP] Continue: residual userInputs to consume");
        continue;
      }
      logger.info("[LOOP] Stop: Last message is", lastMessage.role, "(no sense activity)");
      stopped = true;
      break;
    }

    // 仅当 while 条件耗尽（非 break）才报 max loop 超限。
    // 旧实现 `times >= maxLoop` 在第 maxLoop 轮正常 break 时（times===maxLoop）会误报。
    if (!stopped && times >= maxLoop) {
      logger.info("\n[LOOP] ⚠ Max loop count reached (" + maxLoop + ")");
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

    logger.info("\n[LOOP] Loop ended after " + times + " iterations");
    logger.info("▼".repeat(60) + "\n");

    // loop 结束后 yield done（表示整个流程完成）
    const doneChunk: DoneChunk = { type: "done" };
    yield doneChunk;
  };
}