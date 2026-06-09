import type { MiddlewareContext, MiddlewareChunk, SenseTriggerChunk, StreamChunk } from "@/core/middleware/types";
import { safeJsonParse } from "@/utils/json.js";
import { SupervisionLevel } from "@/core/config";
import { logger } from "@/utils/logger/index.js";

/**
 * Sense Middleware
 * 职责：
 * 1. 从 stream chunks 实时收集 senseDelta
 * 2. 检测完整 sense call 并立即执行
 * 3. auto 感官自动执行，confirm/manual 感官 yield sense_end chunk
 * 4. interrupt 创建和审批由 service 层 interruptMiddleware 处理
 */
export async function* senseMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // senseDelta 累积器（按 index 累积）
  const senseDeltaMap = new Map<number, { id?: string; name?: string; argsJson: string }>();
  let lastIndex = -1;

  logger.info("\n[SENSE] Middleware started");

  // 收集 stream chunks 的 senseDelta，实时检测完整 sense call
  for await (const chunk of next()) {
    // 处理 stream chunk 中的 senseDelta
    if (chunk.type === "stream") {
      const streamChunk = chunk as StreamChunk;
      if (streamChunk.senseDelta && streamChunk.senseDelta.length > 0) {
        for (const delta of streamChunk.senseDelta) {
          const index = delta.index ?? 0;

          // index 变化 → 前一个 sense call 完成
          if (lastIndex !== -1 && index !== lastIndex) {
            const prevSc = senseDeltaMap.get(lastIndex);
            if (prevSc && prevSc.name) {
              logger.info("\n[SENSE] Complete sense call detected (index changed)");
              logger.info("[SENSE] Name:", prevSc.name);
              logger.info("[SENSE] Args:", prevSc.argsJson);
              // 立即执行前一个完整的 sense call
              yield* executeSenseCall(ctx, prevSc.id ?? "", prevSc.name, prevSc.argsJson);
            }
            senseDeltaMap.delete(lastIndex);
          }

          // 累积当前 senseDelta
          const existing = senseDeltaMap.get(index);
          if (existing) {
            existing.argsJson += delta.arguments ?? "";
            if (delta.id) existing.id = delta.id;
            if (delta.name) existing.name = delta.name;
          } else {
            senseDeltaMap.set(index, {
              id: delta.id,
              name: delta.name,
              argsJson: delta.arguments ?? "",
            });
          }

          lastIndex = index;
        }
      }
    }

    // 透传其他 chunk
    yield chunk;
  }

  // 流结束后，处理剩余的 sense call
  logger.info("\n[SENSE] Stream ended, processing remaining sense calls");
  for (const [, sc] of senseDeltaMap) {
    if (sc.name) {
      logger.info("[SENSE] Remaining sense:", sc.name);
      yield* executeSenseCall(ctx, sc.id ?? "", sc.name, sc.argsJson);
    }
  }

  logger.info("[SENSE] Middleware ended\n");
}

/**
 * 执行单个 sense call（根据 supervisionLevel 决定执行策略）
 */
async function* executeSenseCall(
  ctx: MiddlewareContext,
  id: string,
  name: string,
  argsJson: string,
): AsyncGenerator<MiddlewareChunk> {
  // 获取感官监管级别
  const senseDef = ctx.senseManager.get(name);
  // TODO 后半段应该不可能触发才对
  const supervisionLevel = senseDef?.supervisionLevel ?? SupervisionLevel.confirm;

  logger.info("\n" + "⚡".repeat(40));
  logger.info("[SENSE EXEC] Sense call execution");
  logger.info("[SENSE EXEC] ID:", id);
  logger.info("[SENSE EXEC] Name:", name);
  logger.info("[SENSE EXEC] Args:", argsJson);
  logger.info("[SENSE EXEC] Supervision:", supervisionLevel);
  logger.info("⚡".repeat(40) + "\n");

  // 构建 trigger chunk，包含 approvalResolve 用于等待审批
  let approvalResolve: ((action: "accept" | "reject", reason?: string) => void) | null = null;
  const approvalPromise = new Promise<{ action: "accept" | "reject"; reason?: string }>((resolve) => {
    approvalResolve = (action, reason) => resolve({ action, reason });
  });

  const trigger: SenseTriggerChunk = {
    type: "sense_end",
    id,
    name,
    arguments: argsJson,
    supervisionLevel,
    approvalResolve,
  };

  // 所有感官先 yield sense_end
  yield trigger;

  // 执行或拒绝
  if (supervisionLevel > SupervisionLevel.auto) {
    // confirm/manual：等待审批结果
    logger.info("[SENSE EXEC] ⏳ Waiting for approval...");

    const decision = await approvalPromise;

    logger.info("\n[SENSE EXEC] ✅ Approval received");
    logger.info("[SENSE EXEC] Action:", decision.action);
    logger.info("[SENSE EXEC] Reason:", decision.reason || "(none)");

    if (decision.action === "accept") {
      logger.info("[SENSE EXEC] Executing sense...");
      const result = await doExecuteSense(ctx, name, argsJson);
      logger.info("[SENSE EXEC] Result:", result.slice(0, 200) + (result.length > 200 ? "..." : ""));
      yield { type: "sense_accept", id, name, result };
    } else {
      logger.info("[SENSE EXEC] ❌ Rejected by user");
      yield {
        type: "sense_reject",
        id,
        name,
        reason: "用户拒绝执行" + (decision.reason ? `理由:${decision.reason}` : ''),
      };
    }
  } else {
    // auto：直接执行
    logger.info("[SENSE EXEC] Auto mode, executing directly...");
    const result = await doExecuteSense(ctx, name, argsJson);
    logger.info("[SENSE EXEC] Result:", result.slice(0, 200) + (result.length > 200 ? "..." : ""));
    yield { type: "sense_accept", id, name, result };
  }

  logger.info("\n[SENSE EXEC] Sense call completed\n");
}

/**
 * 实际执行感官
 */
async function doExecuteSense(
  ctx: MiddlewareContext,
  name: string,
  argsJson: string,
): Promise<string> {
  try {
    const args = argsJson ? safeJsonParse(argsJson, {}) : {};
    const result = await ctx.senseManager.execute(name, args, ctx.soul.senseSharedData);

    // 去重检查
    if (result.hash) {
      if (ctx.soul.hashCheck.has(result.hash)) {
        return `[已跳过"${name}"重复调用] 前面已有完全相同操作`;
      }
      ctx.soul.hashCheck.set(result.hash, name);
    }

    return result.content;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return `Sense execution failed: ${errorMsg}`;
  }
}

export default senseMiddleware;