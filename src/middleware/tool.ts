import type { MiddlewareContext, MiddlewareChunk, ToolCallAccumulator } from "./types";
import { SupervisionLevel } from "./types";
import { getToolAdapter } from "@/tool/adapter";

/**
 * Tool Middleware
 * 职责：
 * 1. 工具定义构建（前半部分）
 * 2. 流式工具调用累积（前半部分）
 * 3. 分级检查 + tool 执行 + 结果写入（后半部分）
 */
export async function* toolMiddleware(
  ctx: MiddlewareContext,
  next: () => Promise<void> | AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // === 前半部分：准备阶段 ===
  ctx.toolCallAccumulated = new Map();

  // 调用下一层获取响应
  const generator = next() as AsyncGenerator<MiddlewareChunk>;
  for await (const chunk of generator) {
    yield chunk;
  }

  // === 后半部分：tool 执行阶段 ===
  yield* executeToolCalls(ctx);
}

/**
 * 执行 tool calls（分级检查 + 执行 + 结果写入）
 * 非流式：从 ctx.response 或 ctx.pendingToolCalls 提取
 * 流式：从 ctx.toolCallAccumulated 提取
 */
async function* executeToolCalls(
  ctx: MiddlewareContext,
): AsyncGenerator<MiddlewareChunk> {
  const toolAdapter = getToolAdapter(ctx.config.provider);
  if (!toolAdapter) return;

  // 获取 tool calls
  let toolCalls: unknown[];
  if (ctx.isStream) {
    toolCalls = extractFromAccumulated(ctx.toolCallAccumulated);
  } else {
    // 非流式模式：从响应提取并存入 pendingToolCalls（供 message.ts 构建 assistant 消息）
    const extracted = toolAdapter.extractToolCalls(ctx.response);
    ctx.pendingToolCalls = extracted;
    toolCalls = extracted;
  }

  if (toolCalls.length === 0) return;

  const autoLevel = ctx.config.autoExecuteLevel ?? SupervisionLevel.confirm;

  for (const tc of toolCalls) {
    const id = toolAdapter.getToolCallId(tc);
    const name = toolAdapter.getToolCallName(tc);
    const args = toolAdapter.parseToolCallArguments(tc);

    const toolDef = ctx.toolManager.get(name);

    // 分级检查
    if (toolDef && toolDef.supervisionLevel <= autoLevel) {
      // 自动执行
      try {
        const result = await ctx.toolManager.execute(name, args);

        // 写入执行结果到 toolCallAccumulated（message 后半部分负责累积到 history）
        const accumulator = ctx.toolCallAccumulated.get(id);
        if (accumulator) {
          accumulator.executionResult = {
            success: true,
            result,
            toolCallId: id,
            toolName: name,
          };
        } else {
          // 非流式模式下可能没有累积器，创建新的
          ctx.toolCallAccumulated.set(id, {
            id,
            name,
            arguments: JSON.stringify(args),
            executionResult: {
              success: true,
              result,
              toolCallId: id,
              toolName: name,
            },
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        // 写入失败结果（message 后半部分负责处理）
        const accumulator = ctx.toolCallAccumulated.get(id);
        if (accumulator) {
          accumulator.executionResult = {
            success: false,
            error: errorMsg,
            toolCallId: id,
            toolName: name,
          };
        } else {
          ctx.toolCallAccumulated.set(id, {
            id,
            name,
            arguments: JSON.stringify(args),
            executionResult: {
              success: false,
              error: errorMsg,
              toolCallId: id,
              toolName: name,
            },
          });
        }
      }
    } else {
      // 需确认，yield 中断
      ctx.needInterrupt = true;
      ctx.interruptInfo = { toolCallId: id, toolName: name, args };

      yield {
        type: "interrupt",
        toolCallId: id,
        toolName: name,
        args,
        threadId: ctx.threadId,
      };
      return;
    }
  }
}

/**
 * 从累积器提取完整的 tool calls
 */
function extractFromAccumulated(
  accumulated: Map<string, ToolCallAccumulator>,
): unknown[] {
  return Array.from(accumulated.values()).map((acc) => ({
    id: acc.id,
    name: acc.name,
    arguments: acc.arguments,
  }));
}

/**
 * 继续执行工具调用（用户确认后）
 * 由外部调用
 */
export async function* continueToolExecution(
  ctx: MiddlewareContext,
  approved: boolean,
): AsyncGenerator<MiddlewareChunk> {
  if (!ctx.interruptInfo) {
    throw new Error("No pending tool call to continue");
  }

  const { toolCallId, toolName, args } = ctx.interruptInfo;
  ctx.interruptInfo = undefined;
  ctx.needInterrupt = false;

  if (!approved) {
    // 用户拒绝
    const accumulator = ctx.toolCallAccumulated.get(toolCallId);
    if (accumulator) {
      accumulator.executionResult = {
        success: false,
        error: "用户拒绝执行该操作",
        toolCallId,
        toolName,
      };
    } else {
      ctx.toolCallAccumulated.set(toolCallId, {
        id: toolCallId,
        name: toolName,
        arguments: JSON.stringify(args),
        executionResult: {
          success: false,
          error: "用户拒绝执行该操作",
          toolCallId,
          toolName,
        },
      });
    }
  } else {
    // 用户确认执行
    try {
      const result = await ctx.toolManager.execute(toolName, args);
      const accumulator = ctx.toolCallAccumulated.get(toolCallId);
      if (accumulator) {
        accumulator.executionResult = {
          success: true,
          result,
          toolCallId,
          toolName,
        };
      } else {
        ctx.toolCallAccumulated.set(toolCallId, {
          id: toolCallId,
          name: toolName,
          arguments: JSON.stringify(args),
          executionResult: {
            success: true,
            result,
            toolCallId,
            toolName,
          },
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const accumulator = ctx.toolCallAccumulated.get(toolCallId);
      if (accumulator) {
        accumulator.executionResult = {
          success: false,
          error: errorMsg,
          toolCallId,
          toolName,
        };
      } else {
        ctx.toolCallAccumulated.set(toolCallId, {
          id: toolCallId,
          name: toolName,
          arguments: JSON.stringify(args),
          executionResult: {
            success: false,
            error: errorMsg,
            toolCallId,
            toolName,
          },
        });
      }
    }
  }
}