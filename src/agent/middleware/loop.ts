import type { MiddlewareContext, LoopHandler, ErrorChunk, DoneChunk, HeartbeatChunk } from "@/core/middleware/types";
import type { MiddlewareChunk } from "./index";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";
import { hasHeartbeatListener } from "@/agent/spawnBroker.js";

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

    logger.event("loop.start", { max: maxLoop });

    while (times < maxLoop) {
      times++;

      logger.event("loop.iter", { n: times });

      yield* runChain();

      // 检查 loop 停止条件（基于 ctx.soul.messages）
      const messages = ctx.soul.messages;
      if (!messages || messages.length === 0) {
        if (ctx.soul.userInputs.length > 0) {
          logger.event("loop.decision", { decision: "continue", reason: "residual-userInputs-empty-messages" });
          continue;
        }
        logger.event("loop.decision", { decision: "stop", reason: "no-messages" });
        stopped = true;
        break;
      }

      // P1-9：跳过已撤回 revoked（revokeTrailingCycle 后末尾可能为 revoked），取最后一条可见消息
      //       判定 loop 分支，避免 revoked 末尾误判（sense→continue / assistant 无 senseCall→stop）。
      const lastVisible = [...messages].reverse().find(m => !m.revoked);

      // 全部 revoked 或无可判定消息 → 残留输入则继续，否则停止
      if (!lastVisible) {
        if (ctx.soul.userInputs.length > 0) {
          logger.event("loop.decision", { decision: "continue", reason: "residual-userInputs-no-visible" });
          continue;
        }
        logger.event("loop.decision", { decision: "stop", reason: "no-visible-message" });
        stopped = true;
        break;
      }

      // 1. 最后一条是 sense → 刚执行完感官 → 继续 loop（获取 LLM 新响应）
      if (lastVisible.role === "sense") {
        logger.event("loop.decision", { decision: "continue", reason: "last-sense" });
        continue;
      }

      // 2. 最后一条是 assistant 且有 senseCalls → 感官调用完成 → 继续 loop（执行下一轮感官）
      if (lastVisible.role === "assistant" && lastVisible.senseCalls?.length) {
        logger.event("loop.decision", {
          decision: "continue",
          reason: "assistant-senseCalls",
          senses: lastVisible.senseCalls.map(sc => sc.name),
        });
        continue;
      }

      // 3. 其他情况（assistant 无 senseCall / user / system）→ 检查残留输入后再停止
      if (ctx.soul.userInputs.length > 0) {
        logger.event("loop.decision", { decision: "continue", reason: "residual-userInputs" });
        continue;
      }
      logger.event("loop.decision", { decision: "stop", reason: `last-${lastVisible.role}`, lastRole: lastVisible.role });
      stopped = true;
      break;
    }

    // 仅当 while 条件耗尽（非 break）才报 max loop 超限。
    // 旧实现 `times >= maxLoop` 在第 maxLoop 轮正常 break 时（times===maxLoop）会误报。
    if (!stopped && times >= maxLoop) {
      logger.event("loop.max", { max: maxLoop }, LogLevel.warn);
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

    logger.event("loop.end", { iterations: times });

    // 整个 loop 正常结束 → 子 agent 任务完成,发 finished 心跳(per-loop,非 per-iter)。
    // 之前 finished 挂在 heartbeat middleware(per-iter),每轮 runChain 结束都发 → spawn wait=true
    // 在子首轮 assistant 就 resolve(2026-07-09 chat 27b1dbda 实测:主 +6s 收到子首条 assistant
    // 误判完成自己重做,子 +77s 工作全废)。移到此处确保只在子彻底完成时发一次。
    // result = 最后一条 assistant content(spawn wait=true 主 agent 据此 resolve)。
    // hasHeartbeatListener 守卫:仅被 wait 的子 chat 发,过滤主 agent(主也跑 loop,无 listener)。
    // 注:runChain 内 throw 路径下 finished 不执行(throw 跳过此处),error 由 heartbeat middleware catch 发。
    if (hasHeartbeatListener(ctx.soul.chatId)) {
      const result =
        ctx.journal.getMessages().filter(m => m.role === "assistant").pop()?.content || "";
      const finishedHeartbeat: HeartbeatChunk = {
        type: "heartbeat",
        heartbeat: {
          childChatId: ctx.soul.chatId,
          status: "finished",
          result,
          timestamp: Date.now(),
        },
      };
      yield finishedHeartbeat as unknown as MiddlewareChunk;
    }

    // loop 结束后 yield done（表示整个流程完成）
    const doneChunk: DoneChunk = { type: "done" };
    yield doneChunk;
  };
}