import type { MiddlewareContext, MiddlewareChunk, ToolTriggerChunk, ToolCompleteChunk, StreamChunk } from "@/core/middleware/types";
import { interruptManager } from "@/service/agent/interrupt.js";
import { safeJsonParse } from "@/utils/json.js";
import { SupervisionLevel } from "@/core/config";

/**
 * Tool Middleware
 * 职责：
 * 1. 从 stream chunks 实时收集 toolDelta
 * 2. 检测完整 tool call 并立即执行
 * 3. auto 工具自动执行，confirm 工具创建 interrupt
 */
export async function* toolMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // toolDelta 累积器（按 index 累积）
  const toolDeltaMap = new Map<number, { id?: string; name?: string; argsJson: string }>();
  let lastIndex = -1;

  // 收集 stream chunks 的 toolDelta，实时检测完整 tool call
  for await (const chunk of next()) {
    // 处理 stream chunk 中的 toolDelta
    if (chunk.type === "stream") {
      const streamChunk = chunk as StreamChunk;
      if (streamChunk.toolDelta && streamChunk.toolDelta.length > 0) {
        for (const delta of streamChunk.toolDelta) {
          const index = delta.index ?? 0;

          // index 变化 → 前一个 tool call 完成
          if (lastIndex !== -1 && index !== lastIndex) {
            const prevTc = toolDeltaMap.get(lastIndex);
            if (prevTc && prevTc.name) {
              // 立即执行前一个完整的 tool call
              yield* executeToolCall(ctx, prevTc.id ?? "", prevTc.name, prevTc.argsJson);
            }
            toolDeltaMap.delete(lastIndex);
          }

          // 累积当前 toolDelta
          const existing = toolDeltaMap.get(index);
          if (existing) {
            existing.argsJson += delta.arguments ?? "";
            if (delta.id) existing.id = delta.id;
            if (delta.name) existing.name = delta.name;
          } else {
            toolDeltaMap.set(index, {
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

  // 流结束后，处理剩余的 tool call
  for (const [, tc] of toolDeltaMap) {
    if (tc.name) {
      yield* executeToolCall(ctx, tc.id ?? "", tc.name, tc.argsJson);
    }
  }
}

/**
 * 执行单个 tool call（根据 supervisionLevel 决定执行策略）
 */
async function* executeToolCall(
  ctx: MiddlewareContext,
  id: string,
  name: string,
  argsJson: string,
): AsyncGenerator<ToolCompleteChunk> {
  // 获取工具监管级别
  const toolDef = ctx.toolManager.get(name);
  const supervisionLevel = toolDef?.supervisionLevel ?? SupervisionLevel.auto;

  if (supervisionLevel === SupervisionLevel.auto) {
    // auto：直接执行
    const result = await doExecuteTool(ctx, name, argsJson);
    yield { type: "tool_complete", id, name, result };
  } else if (supervisionLevel === SupervisionLevel.confirm) {
    // confirm：创建 interrupt，等待确认
    yield* handleConfirmToolCall(ctx, id, name, argsJson);
  }
  // manual：不执行，直接跳过（不 yield tool_complete）
}

/**
 * 实际执行工具
 */
async function doExecuteTool(
  ctx: MiddlewareContext,
  name: string,
  argsJson: string,
): Promise<string> {
  try {
    const args = argsJson ? safeJsonParse(argsJson, {}) : {};
    const result = await ctx.toolManager.execute(name, args, ctx.session.toolSharedData);

    // 去重检查
    if (result.hash) {
      if (ctx.session.hashCheck.has(result.hash)) {
        return `[已跳过"${name}"重复调用] 前面已有完全相同操作`;
      }
      ctx.session.hashCheck.set(result.hash, name);
    }

    return result.content;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return `Tool execution failed: ${errorMsg}`;
  }
}

/**
 * 处理需确认的 tool call
 */
async function* handleConfirmToolCall(
  ctx: MiddlewareContext,
  id: string,
  name: string,
  argsJson: string,
): AsyncGenerator<ToolCompleteChunk> {
  // 创建 interrupt（构建临时 trigger 格式）
  const trigger: ToolTriggerChunk = {
    type: "tool_trigger",
    id,
    name,
    arguments: argsJson,
    supervisionLevel: "confirm",
  };

  await interruptManager.createSingleInterrupt(ctx, trigger);

  // 等待确认
  const decision = await waitForConfirmation(id);

  // 根据决策执行或跳过
  if (decision.action === "accept") {
    const result = await doExecuteTool(ctx, name, argsJson);
    yield { type: "tool_complete", id, name, result };
  } else {
    yield {
      type: "tool_complete",
      id,
      name,
      result: `用户拒绝执行${decision.reason ? `，原因是${decision.reason}` : ""}`,
    };
  }

  await interruptManager.completeInterrupt(id);
}

/**
 * 等待确认（指数退避轮询）
 */
async function waitForConfirmation(
  interruptId: string,
): Promise<{ action: "accept" | "reject"; reason?: string }> {
  return new Promise((resolve) => {
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const entry = interruptManager.getHandle(interruptId);
        if (!entry) {
          // 已被确认，默认 accept
          resolve({ action: "accept" as const });
          return;
        }
      } catch {
        // 继续轮询
      }
      // 指数退避：1s → 2s → 4s → ... → max 30s
      delay = Math.min(delay * 2, 30000);
      timer = setTimeout(poll, delay);
    };

    // 首次轮询
    timer = setTimeout(poll, delay);

    // 超时 10 分钟
    setTimeout(() => {
      if (timer) clearTimeout(timer);
      resolve({ action: "reject" as const, reason: "Timeout" });
    }, 600000);
  });
}

export default toolMiddleware;