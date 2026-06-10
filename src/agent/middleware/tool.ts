import type { MiddlewareContext, MiddlewareChunk, SenseTriggerChunk, StreamChunk } from "@/core/middleware/types";
import { safeJsonParse } from "@/utils/json.js";
import { SupervisionLevel } from "@/core/config";
import { logger } from "@/utils/logger/index.js";

/**
 * 待批量执行的 sense call
 */
interface PendingSenseCall {
  id: string;
  name: string;
  argsJson: string;
  supervisionLevel: SupervisionLevel;
  /** confirm/manual 时存在，用于 Promise.all 批量等待审批 */
  approvalPromise?: Promise<{ action: "accept" | "reject"; reason?: string }>;
}

/**
 * Sense Middleware（批量模式 + Recovery）
 * 职责：
 * 1. Phase 0（Recovery）：从 messages 检测未完成的 pending sense，重新发起审批并执行
 * 2. Phase 1：从 stream chunks 收集 senseDelta，检测完整 sense call，yield sense_end 触发器
 * 3. Phase 2：流结束后，auto sense 先执行；confirm/manual 批量 await Promise.all 等待审批后执行
 */
export async function* senseMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  const collectedCalls: PendingSenseCall[] = [];

  logger.info("\n[SENSE] Middleware started");

  // Phase 0: Recovery — 从已有 messages 中检测 pending sense（中断恢复）
  const pendingInHistory = (ctx.soul.messages ?? []).filter(
    msg => msg.role === "sense" && (!msg.content || msg.content.trim() === "")
  );

  if (pendingInHistory.length > 0) {
    logger.info(`[SENSE] Phase 0: Found ${pendingInHistory.length} pending sense messages for recovery`);

    for (const msg of pendingInHistory) {
      if (!msg.senseCalls || msg.senseCalls.length === 0) continue;
      for (const sc of msg.senseCalls) {
        logger.info("[SENSE] Recovery sense:", sc.name, "id:", sc.id);
        const { trigger, call } = buildSenseTrigger(ctx, sc.id, sc.name, sc.arguments);
        collectedCalls.push(call);
        yield trigger;
      }
    }

    // 执行 recovery senses
    yield* executeCollectedCalls(ctx, collectedCalls);
    // 清空 collectedCalls，Phase 1 会重新收集
    collectedCalls.length = 0;
  }

  // Phase 1: 收集 sense calls + yield sense_end 触发器
  const senseDeltaMap = new Map<number, { id?: string; name?: string; argsJson: string }>();
  let lastIndex = -1;

  for await (const chunk of next()) {
    if (chunk.type === "stream") {
      const streamChunk = chunk as StreamChunk;
      if (streamChunk.senseDelta && streamChunk.senseDelta.length > 0) {
        for (const delta of streamChunk.senseDelta) {
          const index = delta.index ?? 0;

          if (lastIndex !== -1 && index !== lastIndex) {
            const prevSc = senseDeltaMap.get(lastIndex);
            if (prevSc && prevSc.name) {
              logger.info("\n[SENSE] Complete sense call detected (index changed)");
              logger.info("[SENSE] Name:", prevSc.name);
              logger.info("[SENSE] Args:", prevSc.argsJson);
              const { trigger, call } = buildSenseTrigger(ctx, prevSc.id ?? "", prevSc.name, prevSc.argsJson);
              collectedCalls.push(call);
              yield trigger;
            }
            senseDeltaMap.delete(lastIndex);
          }

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

    yield chunk;
  }

  // 流结束后，处理剩余的 sense calls
  logger.info("\n[SENSE] Stream ended, processing remaining sense calls");
  for (const [, sc] of senseDeltaMap) {
    if (sc.name) {
      logger.info("[SENSE] Remaining sense:", sc.name);
      const { trigger, call } = buildSenseTrigger(ctx, sc.id ?? "", sc.name, sc.argsJson);
      collectedCalls.push(call);
      yield trigger;
    }
  }

  // Phase 2: 批量执行
  if (collectedCalls.length > 0) {
    logger.info(`\n[SENSE] Batch execution: ${collectedCalls.length} sense calls`);
    yield* executeCollectedCalls(ctx, collectedCalls);
  } else {
    logger.info("[SENSE] No sense calls to execute\n");
  }

  logger.info("[SENSE] Middleware ended\n");
}

/**
 * 批量执行收集到的 sense calls
 * Phase 0 (recovery) 和 Phase 2 (normal) 共用
 */
async function* executeCollectedCalls(
  ctx: MiddlewareContext,
  calls: PendingSenseCall[],
): AsyncGenerator<MiddlewareChunk> {
  // Auto sense 先执行（不等待审批）
  const autoCalls = calls.filter(c => c.supervisionLevel === SupervisionLevel.auto);
  for (const call of autoCalls) {
    logger.info("\n" + "⚡".repeat(40));
    logger.info(`[SENSE EXEC] Auto mode, executing directly: ${call.name}`);
    logger.info("[SENSE EXEC] ID:", call.id);
    logger.info("[SENSE EXEC] Args:", call.argsJson);
    logger.info("⚡".repeat(40) + "\n");

    const { content, hash } = await doExecuteSense(ctx, call.name, call.argsJson, call.id);
    logger.info("[SENSE EXEC] Result:", content.slice(0, 200) + (content.length > 200 ? "..." : ""));
    yield { type: "sense_accept", id: call.id, name: call.name, result: content, hash };
  }

  // Confirm/manual senses — 批量等待所有审批后逐一执行
  const needsApproval = calls.filter(c => c.approvalPromise);
  if (needsApproval.length > 0) {
    logger.info(`[SENSE EXEC] ⏳ Waiting for ${needsApproval.length} approvals...`);

    await Promise.all(needsApproval.map(c => c.approvalPromise!));

    logger.info(`\n[SENSE EXEC] ✅ All ${needsApproval.length} approvals received`);

    for (const call of needsApproval) {
      const decision = await call.approvalPromise!;

      if (decision.action === "accept") {
        logger.info("\n" + "⚡".repeat(40));
        logger.info(`[SENSE EXEC] Executing sense: ${call.name}`);
        logger.info("[SENSE EXEC] ID:", call.id);
        logger.info("[SENSE EXEC] Args:", call.argsJson);
        logger.info("⚡".repeat(40) + "\n");

        const { content, hash } = await doExecuteSense(ctx, call.name, call.argsJson, call.id);
        logger.info("[SENSE EXEC] Result:", content.slice(0, 200) + (content.length > 200 ? "..." : ""));
        yield { type: "sense_accept", id: call.id, name: call.name, result: content, hash };
      } else {
        logger.info(`[SENSE EXEC] ❌ Rejected: ${call.name}`);
        logger.info("[SENSE EXEC] Reason:", decision.reason || "(none)");
        yield {
          type: "sense_reject",
          id: call.id,
          name: call.name,
          reason: "用户拒绝执行" + (decision.reason ? `理由:${decision.reason}` : ''),
        };
      }
    }
  }
}

/**
 * 构建 sense trigger + pending call（不执行）
 * trigger 携带 approvalResolve 供 service 层注册到 ApprovalManager
 * call 携带 approvalPromise 供 senseMiddleware 批量 await
 */
function buildSenseTrigger(
  ctx: MiddlewareContext,
  id: string,
  name: string,
  argsJson: string,
): { trigger: SenseTriggerChunk; call: PendingSenseCall } {
  const senseDef = ctx.senseManager.get(name);
  const supervisionLevel = senseDef?.supervisionLevel ?? SupervisionLevel.confirm;

  logger.info("\n" + "⚡".repeat(40));
  logger.info("[SENSE BUILD] Sense trigger built");
  logger.info("[SENSE BUILD] ID:", id);
  logger.info("[SENSE BUILD] Name:", name);
  logger.info("[SENSE BUILD] Args:", argsJson);
  logger.info("[SENSE BUILD] Supervision:", supervisionLevel);
  logger.info("⚡".repeat(40) + "\n");

  let approvalResolve: ((action: "accept" | "reject", reason?: string) => void) | null = null;
  let approvalPromise: Promise<{ action: "accept" | "reject"; reason?: string }> | undefined;

  if (supervisionLevel > SupervisionLevel.auto) {
    approvalPromise = new Promise<{ action: "accept" | "reject"; reason?: string }>((resolve) => {
      approvalResolve = (action, reason) => resolve({ action, reason });
    });
  }

  const trigger: SenseTriggerChunk = {
    type: "sense_end",
    id,
    name,
    arguments: argsJson,
    supervisionLevel,
    approvalResolve,
  };

  return {
    trigger,
    call: { id, name, argsJson, supervisionLevel, approvalPromise },
  };
}

/**
 * 实际执行感官
 */
async function doExecuteSense(
  ctx: MiddlewareContext,
  name: string,
  argsJson: string,
  id: string,
): Promise<{ content: string; hash?: string }> {
  try {
    const args = argsJson ? safeJsonParse(argsJson, {}) : {};
    const result = await ctx.senseManager.execute(name, args, ctx.soul.senseSharedData);

    // 历史替换逻辑：检查历史 sense 消息是否有相同 hash
    if (result.hash) {
      const messages = ctx.soul.messages ?? [];
      for (const msg of messages) {
        if (msg.role === "sense" && msg.hash === result.hash && !msg.replace?.state) {
          msg.replace = {
            state: true,
            by: id,
            content: `旧内容已过时，后续已加载新内容替换。替换该数据的id:${id}`,
          };
          msg.originalContent = msg.content;
          logger.info("\n[SENSE EXEC] 🔄 Replaced historical sense message");
          logger.info("[SENSE EXEC] Old ID:", msg.id);
          logger.info("[SENSE EXEC] New ID:", id);
          logger.info("[SENSE EXEC] Hash:", result.hash);
        }
      }
    }

    return { content: result.content, hash: result.hash };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { content: `Sense execution failed: ${errorMsg}` };
  }
}

export default senseMiddleware;
