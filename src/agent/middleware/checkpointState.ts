import { randomUUID } from "crypto";
import type { MiddlewareContext, ToolCompleteChunk } from "@/core/middleware/types";
import type { ToolCallData } from "@/core/tool/adapter";

/**
 * Checkpoint 状态管理
 * 从 checkpointMiddleware 中提取，封装状态累积和消息构建逻辑
 */
export class CheckpointState {
  private thinking = "";
  private content = "";
  private toolDeltas: ToolCallData[] = [];
  private pendingTools = new Map<string, { id: string; name: string; arguments: string }>();
  private toolResults: ToolCompleteChunk[] = [];

  /**
   * 摄入 chunk，更新内部状态
   */
  ingest(chunk: { type: string; thinkingDelta?: string; contentDelta?: string; toolDelta?: ToolCallData[]; id?: string; name?: string; arguments?: string; result?: string }): void {
    switch (chunk.type) {
      case "stream":
        this.thinking += chunk.thinkingDelta ?? "";
        this.content += chunk.contentDelta ?? "";
        if (chunk.toolDelta) {
          this.toolDeltas.push(...chunk.toolDelta);
        }
        break;

      case "tool_trigger":
        if (chunk.id) {
          this.pendingTools.set(chunk.id, {
            id: chunk.id,
            name: chunk.name ?? "",
            arguments: chunk.arguments ?? "",
          });
        }
        break;

      case "tool_complete":
        if (chunk.id) {
          this.pendingTools.delete(chunk.id);
        }
        this.toolResults.push(chunk as ToolCompleteChunk);
        break;
    }
  }

  /**
   * 获取 staged chunk 数据
   */
  getStagedData(): { content: string; thinking: string } {
    return {
      content: this.content,
      thinking: this.thinking,
    };
  }

  /**
   * 追加 assistant 响应和 tool 结果到 messages
   * （userInputs 已在 checkpoint.ts next() 调用前处理）
   */
  appendResponseMessages(ctx: MiddlewareContext): void {
    const mergedToolCalls = mergeToolDeltas(this.toolDeltas);
    const messages = ctx.session.messages ?? [];

    // assistant 响应（包含 thinking 和 toolCalls）
    if (this.content || this.thinking || mergedToolCalls.length > 0) {
      messages.push({
        id: randomUUID(),
        role: "assistant",
        content: this.content,
        thinking: this.thinking,
        toolCalls: mergedToolCalls
          .filter(tc => tc.name)
          .map(tc => ({
            id: tc.id,
            name: tc.name!,
            arguments: tc.arguments,
          })),
        createdAt: Date.now(),
        updateAt: Date.now(),
      });

      // tool 结果
      for (const r of this.toolResults) {
        messages.push({
          id: r.id,
          role: "tool",
          content: r.result,
          createdAt: Date.now(),
          updateAt: Date.now(),
        });
      }
    }

    ctx.session.messages = messages;
  }

  /**
   * 获取持久化所需的 pendingTools
   */
  getPendingToolsArray(): Array<[string, { id: string; name: string; arguments: string }]> {
    return Array.from(this.pendingTools);
  }

  /**
   * 获取累积内容
   */
  getContent(): string {
    return this.content;
  }

  /**
   * 获取累积思考
   */
  getThinking(): string {
    return this.thinking;
  }
}

/**
 * 合并 toolDelta（按 index 合并 arguments）
 * OpenAI 流式：首个 delta 带 id/name，后续只有 arguments 片段
 * Ollama 流式：每个 delta 可能是完整 tool_call
 */
function mergeToolDeltas(deltas: ToolCallData[]): ToolCallData[] {
  // 按 index 累积
  const mergedMap = new Map<number, ToolCallData>();

  for (const delta of deltas) {
    const index = delta.index ?? 0;
    const existing = mergedMap.get(index);

    if (existing) {
      // 累积 arguments（id/name 只在首个 delta 出现）
      existing.arguments += delta.arguments;
      if (delta.id && !existing.id) existing.id = delta.id;
      if (delta.name && !existing.name) existing.name = delta.name;
    } else {
      // 初始化
      mergedMap.set(index, {
        index,
        id: delta.id,
        name: delta.name,
        arguments: delta.arguments,
      });
    }
  }

  // 按 index 排序返回
  return Array.from(mergedMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc);
}