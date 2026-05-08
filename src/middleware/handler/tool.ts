import type {
  MiddlewareContext,
  MiddlewareChunk,
  ToolCallAccumulator,
} from "../types";
import { SupervisionLevel } from "@/config";

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
  ctx.tools.toolCallAccumulated = new Map();

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
 * 统一从 ctx.tools.toolCallAccumulated 提取（chunk.ts 已统一处理）
 */
async function* executeToolCalls(
  ctx: MiddlewareContext,
): AsyncGenerator<MiddlewareChunk> {
  // 获取 tool calls（统一从 toolCallAccumulated）
  const toolCalls = extractFromAccumulated(ctx.tools.toolCallAccumulated);
  // console.log("toolCalls");
  // console.log(toolCalls);

  if (toolCalls.length === 0) return;

  for (const tc of toolCalls) {
    // extractFromAccumulated 返回的是内部格式 {id, name, arguments}
    const id = tc.id as string;
    const name = tc.name as string;
    const argsJson = tc.arguments as string;
    const args = argsJson ? JSON.parse(argsJson) : {};
    // console.log("id,name,args");
    // console.log(id, name, args);
    const toolDef = ctx.tools.toolManager.get(name);
    // console.log("toolDef");
    // console.log(toolDef, ctx.tools.toolManager.getAll());
    // 分级检查：使用工具的 supervisionLevel
    if (toolDef) {
      // 只有 auto 级别的工具允许自动执行
      if (toolDef.supervisionLevel <= SupervisionLevel.auto) {
        // Skill工具特殊处理：防止重复加载
        if (name === "Skill" && args.name) {
          const skillName = args.name as string;
          if (ctx.session.loadedSkills.has(skillName)) {
            // 技能已加载，返回提示信息
            const accumulator = ctx.tools.toolCallAccumulated.get(id);
            if (accumulator) {
              accumulator.executionResult = {
                success: true,
                result: `技能"${skillName}"已在本会话中激活，无需重复加载。请根据已加载的指令继续执行。`,
                toolCallId: id,
                toolName: name,
              };
            } else {
              ctx.tools.toolCallAccumulated.set(id, {
                id,
                name,
                arguments: JSON.stringify(args),
                index: -1,
                executionResult: {
                  success: true,
                  result: `技能"${skillName}"已在本会话中激活，无需重复加载。请根据已加载的指令继续执行。`,
                  toolCallId: id,
                  toolName: name,
                },
              });
            }
            continue; // 跳过执行
          }
        }

        // 自动执行
        try {
          const result = await ctx.tools.toolManager.execute(name, args);
          console.log("result");
          console.log(result);

          // Skill工具执行成功后，记录已加载的技能
          if (name === "Skill" && args.name) {
            ctx.session.loadedSkills.add(args.name as string);
          }

          // 写入执行结果到 toolCallAccumulated（message 后半部分负责累积到 history）
          const accumulator = ctx.tools.toolCallAccumulated.get(id);
          if (accumulator) {
            accumulator.executionResult = {
              success: true,
              result,
              toolCallId: id,
              toolName: name,
            };
          } else {
            // 非流式模式下可能没有累积器，创建新的
            ctx.tools.toolCallAccumulated.set(id, {
              id,
              name,
              arguments: JSON.stringify(args),
              index: -1,
              executionResult: {
                success: true,
                result,
                toolCallId: id,
                toolName: name,
              },
            });
          }
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : String(error);

          // 写入失败结果（message 后半部分负责处理）
          const accumulator = ctx.tools.toolCallAccumulated.get(id);
          if (accumulator) {
            accumulator.executionResult = {
              success: false,
              error: errorMsg,
              toolCallId: id,
              toolName: name,
            };
          } else {
            ctx.tools.toolCallAccumulated.set(id, {
              id,
              name,
              arguments: JSON.stringify(args),
              index: -1,
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
        ctx.state.needInterrupt = true;
        ctx.state.interruptInfo = { toolCallId: id, toolName: name, args };

        yield {
          type: "interrupt",
          toolCallId: id,
          toolName: name,
          args,
        };
        return;
      }
    } else {
      // TODO 这是没找到tool函数，也需要重新执行LLM
    }
  }
}

/**
 * 内部格式 tool call（从 toolCallAccumulated 提取）
 */
interface InternalToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 从累积器提取完整的 tool calls
 */
function extractFromAccumulated(
  accumulated: Map<string, ToolCallAccumulator>,
): InternalToolCall[] {
  return Array.from(accumulated.values()).map((acc) => ({
    id: acc.id ?? `tool-${acc.index}`,
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
  if (!ctx.state.interruptInfo) {
    throw new Error("No pending tool call to continue");
  }

  const { toolCallId, toolName, args } = ctx.state.interruptInfo;
  ctx.state.interruptInfo = undefined;
  ctx.state.needInterrupt = false;

  if (!approved) {
    // 用户拒绝
    const accumulator = ctx.tools.toolCallAccumulated.get(toolCallId);
    if (accumulator) {
      accumulator.executionResult = {
        success: false,
        error: "用户拒绝执行该操作",
        toolCallId,
        toolName,
      };
    } else {
      ctx.tools.toolCallAccumulated.set(toolCallId, {
        id: toolCallId,
        name: toolName,
        arguments: JSON.stringify(args),
        index: -1,
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
      const result = await ctx.tools.toolManager.execute(toolName, args);
      const accumulator = ctx.tools.toolCallAccumulated.get(toolCallId);
      if (accumulator) {
        accumulator.executionResult = {
          success: true,
          result,
          toolCallId,
          toolName,
        };
      } else {
        ctx.tools.toolCallAccumulated.set(toolCallId, {
          id: toolCallId,
          name: toolName,
          arguments: JSON.stringify(args),
          index: -1,
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
      const accumulator = ctx.tools.toolCallAccumulated.get(toolCallId);
      if (accumulator) {
        accumulator.executionResult = {
          success: false,
          error: errorMsg,
          toolCallId,
          toolName,
        };
      } else {
        ctx.tools.toolCallAccumulated.set(toolCallId, {
          id: toolCallId,
          name: toolName,
          arguments: JSON.stringify(args),
          index: -1,
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
