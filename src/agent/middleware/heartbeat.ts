/**
 * 心跳 Middleware（主子 agent 断开恢复容错）
 *
 * 职责（finished 已移至 loopHandler,本 middleware 只管 running + error）：
 * - running：子 agent 执行过程中,每 5s 直调 notifyHeartbeat 通知主 "我还活着"。
 * - error：子 agent 某轮出错时 yield error 心跳(在发生轮立即通知主 reject)。
 * - finished：**已移至 loopHandler**(整个 loop 结束后发)——见 loop.ts。
 *
 * 主 agent wait=true 通过 spawnBroker.registerHeartbeatListener 监听心跳：
 * - 收到 running → 重置 30s 超时计时器   [本 middleware 发]
 * - 收到 error  → reject(错误)           [本 middleware catch 发]
 * - 收到 finished → resolve(结果)         [loopHandler 发]
 * - 30s 未收到任何心跳 → reject(超时)
 *
 * running 实现机制(脱离 chunk 流直调)：
 * setInterval 每 5s 直接调 spawnBroker.notifyHeartbeat 发送,不经 middleware chunk 流。
 * 原因:JS async generator 是 pull-based,外部定时器无法让卡在 `await next()` 的 generator
 * 主动 yield——若 running 走 chunk,LLM 首 token 静默期(generator 阻塞在等下游 chunk)内心跳
 * 虽已入队却无法 flush,主 30s 窗口收不到 running → 误判死亡(2026-07-09 chat 3a00530f 实测)。
 * 直调绕过 chunk 流,LLM 静默期心跳照发。
 *
 * error 仍走 chunk 流(catch 内 yield):error 在某轮 runChain 内 throw 时,本 middleware catch 住
 * 立即 yield error,语义正确(在发生轮通知主 reject)。throw 随后传播退出 loopHandler——此时
 * loopHandler 的 finished 不执行(throw 跳过),不会与 error 冲突。
 *
 * 为何 finished 移 loop 而非留本 middleware:
 * 本 middleware 是 runChain 最外层,loop 每轮 runChain 都重跑一次 → 每轮流结束都 yield finished
 * → spawn wait=true 在子首轮 assistant 就 resolve(2026-07-09 chat 27b1dbda 实测,主 +6s 收到子
 * 首条 assistant 误判完成,自己重做,子 +77s 工作全废)。finished 语义是"整个任务完成"(per-loop),
 * 必须挂 loopHandler 而非 per-iter 的本 middleware。
 *
 * hasHeartbeatListener 守卫:主 agent 也跑本 middleware(统一链),但其 chatId 无 listener。
 * 仅被 wait 的子 chat 才发 running/error,过滤主 agent 无消费者心跳(避免 notifyHeartbeat 噪音 warn)。
 *
 * 注册位置：
 * 应在 checkpoint middleware 外层(最先执行)。error 需在 checkpoint 外才能捕获内层 throw。
 */

import type { MiddlewareContext, MiddlewareChunk } from "@/core/middleware/types.js";
import { notifyHeartbeat, hasHeartbeatListener } from "@/agent/spawnBroker.js";

/** 心跳间隔(5s,与阶段0确认一致) */
const HEARTBEAT_INTERVAL_MS = 5000;

/**
 * 心跳 middleware:running 每 5s 直调(脱离 chunk 流);error 在 catch 内 yield(走 chunk 流)。
 * finished 由 loopHandler 发(整个 loop 结束后)。
 */
export async function* heartbeatMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  const childChatId = ctx.soul.chatId;

  // 启动 5s 定时器:每 5s 直调 notifyHeartbeat 发 running 心跳。
  // 直调(非 chunk yield)绕过 flush 耦合,LLM 首 token 静默期心跳照发,主不会误判超时。
  // hasHeartbeatListener 守卫:仅被 wait 的子 chat 发,过滤主 agent 无消费者心跳。
  const timer = setInterval(() => {
    if (hasHeartbeatListener(childChatId)) {
      notifyHeartbeat(childChatId, "running");
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    for await (const chunk of next()) {
      // yield 原始 chunk(running 已直调,无需在此 flush)
      yield chunk;
    }
    // finished 心跳已移至 loopHandler(per-loop,见 loop.ts),此处不再发。
  } catch (error) {
    // 出错,发 error 心跳(走 chunk 流,observer 转 notifyHeartbeat reject 主 agent)
    // error 在发生轮立即通知主(语义:子某轮出错);守卫过滤主 agent(无 listener)。
    if (hasHeartbeatListener(childChatId)) {
      console.log("[heartbeat] yield error heartbeat:", {
        childChatId,
        error: error instanceof Error ? error.message : String(error),
      });
      yield {
        type: "heartbeat",
        heartbeat: {
          childChatId,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      } as unknown as MiddlewareChunk;
    }
    throw error;
  } finally {
    // 清理定时器
    clearInterval(timer);
  }
}

export default heartbeatMiddleware;
