import type { MiddlewareContext, MiddlewareChunk, ToolTriggerChunk, StreamChunk } from "@/core/middleware/types";
import { safeJsonParse } from "@/utils/json.js";
import { SupervisionLevel } from "@/core/config";

/**
 * Tool Middleware
 * 职责：
 * 1. 从 stream chunks 实时收集 toolDelta
 * 2. 检测完整 tool call 并立即执行
 * 3. auto 工具自动执行，confirm/manual 工具 yield tool_trigger chunk
 * 4. interrupt 创建和审批由 service 层 interruptMiddleware 处理
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
): AsyncGenerator<MiddlewareChunk> {
  // 获取工具监管级别
  const toolDef = ctx.toolManager.get(name);
  const supervisionLevel = toolDef?.supervisionLevel ?? SupervisionLevel.auto;

  // 构建 trigger chunk
  const trigger: ToolTriggerChunk = {
    type: "tool_trigger",
    id,
    name,
    arguments: argsJson,
    supervisionLevel,
  };

  // 所有工具先 yield tool_trigger
  yield trigger;

  // 执行或拒绝
  if (supervisionLevel > SupervisionLevel.auto) {
    // confirm/manual：检查外部挂载的审批结果
    const decision = trigger.approval;
    if (decision?.action === "accept") {
      const result = await doExecuteTool(ctx, name, argsJson);
      yield { type: "tool_complete", id, name, result };
    } else {
      yield {
        type: "tool_complete",
        id,
        name,
        result: decision?.reason ?? "用户拒绝执行",
      };
    }
  } else {
    // auto：直接执行
    const result = await doExecuteTool(ctx, name, argsJson);
    yield { type: "tool_complete", id, name, result };
  }
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

export default toolMiddleware;