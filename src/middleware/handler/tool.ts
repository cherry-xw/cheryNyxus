import type {
  MiddlewareContext,
  MiddlewareChunk,
  ToolExecutionResult,
  ToolCallAccumulator,
} from "../types";
import { SupervisionLevel } from "@/config";
import { v4 as uuid } from "uuid";

/**
 * Tool Middleware
 * 职责：
 * 1. 工具定义构建（前半部分）
 * 2. 流式工具调用累积（前半部分）
 * 3. 分级检查 + tool 执行 + 结果写入 history（后半部分）
 */
export async function* toolMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // === 前半部分：准备阶段 ===

  // 调用下一层获取响应
  yield* next();

  // === 后半部分：tool 执行阶段 ===
  // 过滤出未执行的工具
  const toolCalls = Array.from(ctx.process.toolCallAccumulated.values()).filter(
    (acc) => !acc.approved,
  );

  if (toolCalls.length === 0) return;

  // 执行工具调用
  for (const tc of toolCalls) {
    const toolDef = ctx.tools.toolManager.get(tc.name);
    if (toolDef) {
      const tid = tc.tid;
      const name = tc.name;
      const argsJson = tc.arguments;
      const args = argsJson ? JSON.parse(argsJson) : {};
      // Skill工具重复检测（已废弃，使用统一hashCheck机制）
      if (toolDef.supervisionLevel <= ctx.global.supervision) {
        await executeSingleToolCall(ctx, tid, name, args);
      } else {
        // 需确认，yield 中断
        yield {
          type: "interrupt",
          toolCallId: tid,
          toolName: name,
          args,
          acknowledge: async (action: "accept" | "reject", reason?: string) => {
            if (action === "accept") {
              // 接受：执行工具调用
              await executeSingleToolCall(ctx, tid, name, args);
            } else {
              whiteHistory(
                ctx,
                tid,
                `用户拒绝执行${reason ? `，原因是${reason}` : ""}`,
              );
            }
          },
        };
      }
    } else {
      whiteHistory(ctx, tc.tid, `Tool "${tc.name}" not found`);
    }
  }
}

/**
 * 执行单个工具调用（阻塞执行，执行结束立即删除当前任务，同时将结果存入 history）
 * @param ctx 中间件上下文
 * @param tid 工具调用ID
 * @param name 工具名称
 * @param args 工具参数
 */
export async function executeSingleToolCall(
  ctx: MiddlewareContext,
  tid: string,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  // 自动执行
  try {
    const result = await ctx.tools.toolManager.execute(name, args);

    // 去重检查（hash为""时跳过）
    if (result.hash) {
      if (ctx.session.hashCheck.has(result.hash)) {
        whiteHistory(
          ctx,
          tid,
          `[已跳过”${name}“重复调用] 前面已有完全相同操作，本次直接跳过`,
        );
        return;
      }
      ctx.session.hashCheck.set(result.hash, "");
    }

    whiteHistory(ctx, tid, result.content);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    whiteHistory(ctx, tid, `Tool execution failed: ${errorMsg}`);
  }
}

function whiteHistory(ctx: MiddlewareContext, tid: string, content: string) {
  const history = ctx.process.history;
  const currentToolCall = ctx.process.toolCallAccumulated.get(tid);

  // 首次调用：先 push assistant(toolCalls)
  if (currentToolCall) {
    history.push({
      id: uuid(),
      role: "assistant",
      content: ctx.process.contentAccumulated || "",
      thinking: ctx.process.thinkingAccumulated,
      toolCalls: [
        {
          tid: currentToolCall.tid,
          name: currentToolCall.name,
          arguments: currentToolCall.arguments,
        },
      ],
      createdAt: Date.now(),
      updateAt: Date.now(),
      raw: null,
    });
  }
  // push tool 消息
  const now = Date.now();
  history.push({
    id: tid,
    role: "tool",
    content,
    createdAt: now,
    updateAt: now,
    raw: { toolCallId: tid },
  });
  ctx.process.toolCallAccumulated.delete(tid);
}
