import type { MiddlewareContext, ToolCallAccumulator } from "@/core/middleware/types";
import { v4 as uuid } from "uuid";
import { SupervisionLevel } from "@/core/config";

/**
 * 中断 chunk（工具两阶段确认）
 * 支持批量 handle，每个独立审批
 */
export interface InterruptChunk {
  type: "interrupt";
  /** 批量 handle 数组（每个独立审批，reason 由中间件生成供外部显示） */
  handles: Array<{
    /** 确认执行（接受/拒绝指令） */
    acknowledge: (action: "accept" | "reject", reason?: string) => Promise<void>;
    /** 工具调用描述（由中间件生成：name + args） */
    reason: string;
  }>;
}

/**
 * Tool Middleware
 * 职责：
 * 1. 工具定义构建（前半部分）
 * 2. 流式工具调用累积（前半部分）
 * 3. 分级检查 + 批量并发执行 + 结果写入 history（后半部分）
 */
export async function* toolMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<unknown>,
): AsyncGenerator<InterruptChunk | unknown> {
  // === 前半部分：准备阶段 ===
  yield* next();

  // === 后半部分：tool 执行阶段 ===
  const toolCalls = Array.from(ctx.process.toolCallAccumulated.values()).filter(
    (acc) => !acc.approved,
  );

  if (toolCalls.length === 0) return;

  // execList: Promise 数组，存放 executeSingleToolCall 返回值
  const execList: Promise<{
    tid: string;
    name: string;
    arguments: string;
    result: string;
  }>[] = [];

  // 收集需确认的 toolcalls
  const confirmList: ToolCallAccumulator[] = [];

  for (const tc of toolCalls) {
    const toolDef = ctx.tools.toolManager.get(tc.name);
    if (!toolDef) {
      execList.push(
        Promise.resolve({
          tid: tc.tid,
          name: tc.name,
          arguments: tc.arguments,
          result: `Tool "${tc.name}" not found`,
        }),
      );
    } else {
      console.log("监管等级：", tc.name, toolDef.supervisionLevel)
      if (toolDef.supervisionLevel === SupervisionLevel.auto) {
        const args = tc.arguments ? JSON.parse(tc.arguments) : {};
        execList.push(executeSingleToolCall(ctx, tc.tid, tc.name, args));
      } else {
        confirmList.push(tc);
      }
    }
  }

  // 批量 yield interrupt（如有需确认的）
  if (confirmList.length > 0) {
    yield {
      type: "interrupt",
      handles: confirmList.map((tc) => ({
        acknowledge: async (action: "accept" | "reject", reason?: string) => {
          if (action === "accept") {
            const args = tc.arguments ? JSON.parse(tc.arguments) : {};
            execList.push(executeSingleToolCall(ctx, tc.tid, tc.name, args));
          } else {
            execList.push(
              Promise.resolve({
                tid: tc.tid,
                name: tc.name,
                arguments: tc.arguments,
                result: `用户拒绝执行${reason ? `，原因是${reason}` : ""}`,
              }),
            );
          }
          // 标记已审批
          const current = ctx.process.toolCallAccumulated.get(tc.tid);
          if (current) current.approved = true;
        },
        reason: `${tc.name}(${tc.arguments})`,
      })),
    };

    // yield 后 generator 暂停，外部批量 acknowledge 后恢复
  }

  // 并发执行 execList（Promise.all）
  const results = await Promise.all(execList);

  // 批量 writeHistory
  whiteHistory(ctx, results);
}

/**
 * 执行单个工具调用（仅执行，返回完整信息，不做 writeHistory）
 * @param ctx 中间件上下文
 * @param tid 工具调用ID
 * @param name 工具名称
 * @param args 工具参数
 * @returns 完整执行结果
 */
export async function executeSingleToolCall(
  ctx: MiddlewareContext,
  tid: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  tid: string;
  name: string;
  arguments: string;
  result: string;
}> {
  const argsJson = JSON.stringify(args);

  try {
    const execResult = await ctx.tools.toolManager.execute(name, args, ctx.session.toolSharedData);

    // 去重检查（hash为""时跳过）
    if (execResult.hash) {
      if (ctx.session.hashCheck.has(execResult.hash)) {
        return {
          tid,
          name,
          arguments: argsJson,
          result: `[已跳过"${name}"重复调用] 前面已有完全相同操作，本次直接跳过`,
        };
      }
      ctx.session.hashCheck.set(execResult.hash, name);
    }

    return { tid, name, arguments: argsJson, result: execResult.content };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { tid, name, arguments: argsJson, result: `Tool execution failed: ${errorMsg}` };
  }
}

/**
 * 批量写入 history（一条 assistant + 多条 tool）
 * @param ctx 中间件上下文
 * @param results 执行结果数组
 */
function whiteHistory(
  ctx: MiddlewareContext,
  results: Array<{
    tid: string;
    name: string;
    arguments: string;
    result: string;
  }>,
) {
  const history = ctx.process.history;

  // 1. push 一条 assistant（包含所有 toolCalls）
  history.push({
    id: uuid(),
    role: "assistant",
    content: ctx.process.contentAccumulated || "",
    thinking: ctx.process.thinkingAccumulated,
    toolCalls: results.map((r) => ({
      tid: r.tid,
      name: r.name,
      arguments: r.arguments,
    })),
    createdAt: Date.now(),
    updateAt: Date.now(),
    raw: null,
  });

  // 2. push 多条 tool 消息
  const now = Date.now();
  for (const r of results) {
    history.push({
      id: r.tid,
      role: "tool",
      content: r.result,
      createdAt: now,
      updateAt: now,
      raw: { toolCallId: r.tid },
    });
    // 删除已处理的 toolCallAccumulated
    ctx.process.toolCallAccumulated.delete(r.tid);
  }
}