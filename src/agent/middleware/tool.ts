import type { MiddlewareContext, MiddlewareChunk, SenseTriggerChunk, StreamChunk } from "@/core/middleware/types";
import type { ReplaceInfo } from "@/core/message/adapter";
import { safeJsonParse } from "@/utils/json.js";
import { SupervisionLevel } from "@/core/config";
import { createApproval } from "@/core/sense";
import { setSenseCtxChatId } from "@/agent/sense/processRegistry.js";
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
 * Sense Middleware（批量模式）
 * 职责：
 * 1. Phase 1：从 stream chunks 收集 senseDelta，检测完整 sense call，yield sense_end 触发器
 * 2. Phase 2：流结束后，auto sense 先执行；confirm/manual 批量 await Promise.all 等待审批后执行
 * pending sense 不再自动恢复执行，改由 chat.resume 撤回重跑（见 service/chat/send.ts handleChatResume）
 *
 * trace 日志：sense 触发/执行/拒绝由 chokepoint（streamMapper 的 sense.trigger/result/rejected）
 *   统一发射；此处仅发 chokepoint 不覆盖的 approval.wait（批量等待用户审批）。
 */
export async function* senseMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  const collectedCalls: PendingSenseCall[] = [];

  // resume 续接（chat.resume Case1：末尾有 pending sense）：
  // 首轮 skip chat 层（不调 next / 不调 LLM），从历史 pending 重建 trigger 执行。
  // 同默认审批流一致；工具不在当前 senseTable 静默写「无此工具」结果。
  if (ctx.soul.resumePending) {
    ctx.soul.resumePending = false;
    yield* executeResumePending(ctx);
    return;
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
  for (const [, sc] of senseDeltaMap) {
    if (sc.name) {
      const { trigger, call } = buildSenseTrigger(ctx, sc.id ?? "", sc.name, sc.argsJson);
      collectedCalls.push(call);
      yield trigger;
    }
  }

  // Phase 2: 批量执行
  if (collectedCalls.length > 0) {
    yield* executeCollectedCalls(ctx, collectedCalls);
  }
}

/**
 * 批量执行收集到的 sense calls（Phase 2）
 */
async function* executeCollectedCalls(
  ctx: MiddlewareContext,
  calls: PendingSenseCall[],
): AsyncGenerator<MiddlewareChunk> {
  // Auto sense 先执行（不等待审批）
  const autoCalls = calls.filter(c => c.supervisionLevel === SupervisionLevel.auto);
  for (const call of autoCalls) {
    const { content, hash, replaced } = await doExecuteSense(ctx, call.name, call.argsJson, call.id);
    yield { type: "sense_accept", id: call.id, name: call.name, result: content, hash };
    // 被替换的历史 sense 消息：yield message_updated 让 observer 落库 replace 状态
    for (const r of replaced) {
      yield { type: "message_updated", id: r.id, patch: { content: r.content, replace: r.replace, originalContent: r.originalContent } };
    }
  }

  // Confirm/manual senses — 批量等待所有审批后逐一执行
  const needsApproval = calls.filter(c => c.approvalPromise);
  if (needsApproval.length > 0) {
    logger.event("approval.wait", {
      count: needsApproval.length,
      approvals: needsApproval.map(c => ({ approvalId: c.id, name: c.name, supervisionLevel: c.supervisionLevel })),
    });

    try {
      await Promise.all(needsApproval.map(c => c.approvalPromise!));
    } catch {
      // 审批被 abort（连接断开/超时）：throw 终止整个流程。
      // 不 return：return 只结束 senseMiddleware，loop 会视为本轮完成继续第二轮 LLM 调用，
      //   破坏未完成周期语义（应停在 pending sense 待 canResume）。
      // 不 yield sense_reject：客户端已断连通知无意义，且会填 pending sense content 破坏 canResume。
      // throw 传播：assistant 已在 sense_end 时落库，pending sense 保持 NULL，流程终止不再 loop。
      throw new Error("approval aborted");
    }

    for (const call of needsApproval) {
      const decision = await call.approvalPromise!;

      if (decision.action === "accept") {
        const { content, hash, replaced } = await doExecuteSense(ctx, call.name, call.argsJson, call.id);
        yield { type: "sense_accept", id: call.id, name: call.name, result: content, hash };
        // 被替换的历史 sense 消息：yield message_updated 让 observer 落库 replace 状态
        for (const r of replaced) {
          yield { type: "message_updated", id: r.id, patch: { replace: r.replace, originalContent: r.originalContent } };
        }
      } else {
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
 * 续接执行末尾 pending sense（chat.resume Case1，首轮 skip chat 层）。
 * 从末尾向前收集连续空 content 的 sense 消息，重建 SenseTriggerChunk 执行。
 * 工具不在当前 senseTable → 跳过监管静默写「无此工具:{name}」结果（作 accept，
 *   checkpointState recovery 路径原地更新 pending → done，LLM 据此感知工具不存在）。
 */
async function* executeResumePending(
  ctx: MiddlewareContext,
): AsyncGenerator<MiddlewareChunk> {
  if (!ctx.runtime) throw new Error("Runtime not configured.");
  const messages = ctx.soul.messages ?? [];
  const pending: { id: string; name: string; argsJson: string }[] = [];

  // 末尾连续空 content 的 sense（pending）；遇 done（有 content）即停
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "sense") break;
    if (m.content) break;
    const sc = m.senseCalls?.[0];
    if (sc) {
      pending.unshift({ id: sc.id, name: sc.name, argsJson: sc.arguments });
    }
  }

  if (pending.length === 0) {
    return;
  }

  const calls: PendingSenseCall[] = [];
  for (const p of pending) {
    if (!ctx.runtime.senseTable.has(p.name)) {
      // 工具不在当前 senseTable：静默写占位结果
      yield { type: "sense_accept", id: p.id, name: p.name, result: `无此工具:${p.name}` };
      continue;
    }
    const { trigger, call } = buildSenseTrigger(ctx, p.id, p.name, p.argsJson);
    calls.push(call);
    yield trigger;
  }

  if (calls.length > 0) {
    yield* executeCollectedCalls(ctx, calls);
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
  if (!ctx.runtime) throw new Error("Runtime not configured.");
  const senseEntry = ctx.runtime.senseTable.get(name);
  const supervisionLevel = senseEntry?.supervisionLevel ?? SupervisionLevel.confirm;

  let approvalPromise: Promise<{ action: "accept" | "reject"; reason?: string }> | undefined;

  if (supervisionLevel > SupervisionLevel.auto) {
    // P1-11：审批 Promise 由 core approvalRegistry 管理，resolve/reject 不再随 chunk 传 service。
    //   service ApprovalManager.confirm/abort 调 resolveApproval/rejectApproval 触发本 await。
    approvalPromise = createApproval(id);
  }

  const trigger: SenseTriggerChunk = {
    type: "sense_end",
    id,
    name,
    arguments: argsJson,
    supervisionLevel,
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
): Promise<{
  content: string;
  hash?: string;
  replaced: Array<{ id: string; content: string; replace: ReplaceInfo; originalContent: string }>;
}> {
  const replaced: Array<{ id: string; content: string; replace: ReplaceInfo; originalContent: string }> = [];
  try {
    if (!ctx.runtime) throw new Error("Runtime not configured.");
    const args = argsJson ? safeJsonParse(argsJson, {}) : {};
    const senseEntry = ctx.runtime.senseTable.get(name);
    if (!senseEntry) {
      return { content: `Error: Sense "${name}" not found`, replaced };
    }
    // 注入 chatId 到 sharedData 保留 namespace，供 bash 等需要按 chatId 归属的 sense 读取
    // （executor 签名固定 (args, sharedData) 无 chatId；改全局签名成本过高且仅 bash 需要）
    setSenseCtxChatId(ctx.soul.senseSharedData, ctx.soul.chatId);
    const result = await senseEntry.execute(args, ctx.soul.senseSharedData);

    // 历史替换逻辑：hash 命中（read_file hash 含 mtime）= 文件未变动，新旧读取内容相同。
    // 旧 sense 内容重复且冗长 → 替换为短说明（告知 AI 已被新读取取代），长内容移至 originalContent 折叠溯源。
    // 文件若被改动 → mtime/size 变 → hash 不同 → 各自独立留存上下文（AI 自行对比，不替换）。
    // 故 hash 保留 mtime：它是"内容是否变动"的关键判据，去掉会让等长改写误判为相同。
    if (result.hash) {
      const messages = ctx.soul.messages ?? [];
      for (const msg of messages) {
        if (msg.role === "sense" && msg.hash === result.hash && !msg.replace?.state) {
          // staleNote：剔除冗长重复内容，仅告知 AI 该结果已被新读取取代（by 指向新 sense id）。
          // 同步写回 msg.content（内存）+ 由 message_updated effect 落库 content/replace/originalContent，
          // 使 LLM 历史、DB、web 三处一致：主显短说明，长内容折叠在 originalContent。
          const staleNote = `此条旧读取已被新读取结果取代（新记录 id:${id}），长内容已折叠，以新记录为准。`;
          const replaceInfo: ReplaceInfo = { state: true, by: id, content: staleNote };
          msg.originalContent = msg.content;
          msg.content = staleNote;
          msg.replace = replaceInfo;
          replaced.push({ id: msg.id, content: staleNote, replace: replaceInfo, originalContent: msg.originalContent });
        }
      }
    }

    return { content: result.content, hash: result.hash, replaced };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { content: `Sense execution failed: ${errorMsg}`, replaced };
  }
}

export default senseMiddleware;
