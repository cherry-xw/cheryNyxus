import { randomUUID } from "crypto";
import type { MiddlewareContext, SenseCompleteChunk } from "@/core/middleware/types";
import type { SenseCallData } from "@/core/sense/adapter";

/**
 * Checkpoint 状态管理
 * 从 checkpointMiddleware 中提取，封装状态累积和消息构建逻辑
 */
export class CheckpointState {
  private thinking = "";
  private content = "";
  private senseDeltas: SenseCallData[] = [];
  private pendingSenses = new Map<string, { id: string; name: string; arguments: string }>();
  private senseResults: SenseCompleteChunk[] = [];

  /**
   * 摄入 chunk，更新内部状态
   */
  ingest(chunk: { type: string; thinkingDelta?: string; contentDelta?: string; senseDelta?: SenseCallData[]; id?: string; name?: string; arguments?: string; result?: string }): void {
    switch (chunk.type) {
      case "stream":
        this.thinking += chunk.thinkingDelta ?? "";
        this.content += chunk.contentDelta ?? "";
        if (chunk.senseDelta) {
          this.senseDeltas.push(...chunk.senseDelta);
        }
        break;

      case "sense_trigger":
        if (chunk.id) {
          this.pendingSenses.set(chunk.id, {
            id: chunk.id,
            name: chunk.name ?? "",
            arguments: chunk.arguments ?? "",
          });
        }
        break;

      case "sense_complete":
        if (chunk.id) {
          this.pendingSenses.delete(chunk.id);
        }
        this.senseResults.push(chunk as SenseCompleteChunk);
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
   * 追加 assistant 响应和 sense 结果到 messages
   * （userInputs 已在 checkpoint.ts next() 调用前处理）
   */
  appendResponseMessages(ctx: MiddlewareContext): void {
    const mergedSenseCalls = mergeSenseDeltas(this.senseDeltas);
    const messages = ctx.soul.messages ?? [];

    // assistant 响应（包含 thinking 和 senseCalls）
    if (this.content || this.thinking || mergedSenseCalls.length > 0) {
      messages.push({
        id: randomUUID(),
        role: "assistant",
        content: this.content,
        thinking: this.thinking,
        senseCalls: mergedSenseCalls
          .filter(sc => sc.name)
          .map(sc => ({
            id: sc.id,
            name: sc.name!,
            arguments: sc.arguments,
          })),
        createdAt: Date.now(),
        updateAt: Date.now(),
      });

      // sense 结果
      for (const r of this.senseResults) {
        messages.push({
          id: r.id,
          role: "sense",
          content: r.result,
          createdAt: Date.now(),
          updateAt: Date.now(),
        });
      }
    }

    ctx.soul.messages = messages;
  }

  /**
   * 获取持久化所需的 pendingSenses
   */
  getPendingSensesArray(): Array<[string, { id: string; name: string; arguments: string }]> {
    return Array.from(this.pendingSenses);
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
 * 合并 senseDelta（按 index 合并 arguments）
 * OpenAI 流式：首个 delta 带 id/name，后续只有 arguments 片段
 * Ollama 流式：每个 delta 可能是完整 sense_call
 */
function mergeSenseDeltas(deltas: SenseCallData[]): SenseCallData[] {
  // 按 index 累积
  const mergedMap = new Map<number, SenseCallData>();

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
    .map(([, sc]) => sc);
}