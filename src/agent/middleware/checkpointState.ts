import { randomUUID } from "crypto";
import type { MiddlewareContext, PersistMessageData, SenseAcceptChunk, SenseRejectChunk } from "@/core/middleware/types";
import type { SenseCallData } from "@/core/sense/adapter";
import { logger } from "@/utils/logger/index.js";

/**
 * Checkpoint 状态管理
 * 从 checkpointMiddleware 中提取，封装状态累积和消息构建逻辑
 */
export class CheckpointState {
  private thinking = "";
  private content = "";
  private senseDeltas: SenseCallData[] = [];
  private pendingSenses = new Map<string, { id: string; name: string; arguments: string }>();
  private senseResults: (SenseAcceptChunk | SenseRejectChunk)[] = [];

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

      case "sense_end":
        if (chunk.id) {
          this.pendingSenses.set(chunk.id, {
            id: chunk.id,
            name: chunk.name ?? "",
            arguments: chunk.arguments ?? "",
          });
        }
        break;

      case "sense_accept":
      case "sense_reject":
        if (chunk.id) {
          this.pendingSenses.delete(chunk.id);
        }
        this.senseResults.push(chunk as SenseAcceptChunk | SenseRejectChunk);
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
   * @returns 新创建的消息列表（用于持久化回调）
   */
  appendResponseMessages(ctx: MiddlewareContext): PersistMessageData[] {
    const mergedSenseCalls = mergeSenseDeltas(this.senseDeltas);
    const messages = ctx.soul.messages ?? [];
    const newMessages: PersistMessageData[] = [];

    logger.info("\n[CHECKPOINT] Appending response messages");
    logger.info("[CHECKPOINT] Thinking length:", this.thinking.length);
    logger.info("[CHECKPOINT] Content length:", this.content.length);
    logger.info("[CHECKPOINT] Sense deltas:", this.senseDeltas.length);
    logger.info("[CHECKPOINT] Merged sense calls:", mergedSenseCalls.length);
    logger.info("[CHECKPOINT] Sense results:", this.senseResults.length);

    // assistant 响应（包含 thinking 和 senseCalls）
    if (this.content || this.thinking || mergedSenseCalls.length > 0) {
      const assistantMsg = {
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
      };
      messages.push(assistantMsg);
      newMessages.push({
        id: assistantMsg.id!,
        role: "assistant",
        content: this.content || undefined,
        thinking: this.thinking || undefined,
        senseCalls: assistantMsg.senseCalls,
      });
      logger.info("[CHECKPOINT] ✅ Appended assistant message");
      logger.info("[CHECKPOINT] Sense calls in assistant:", assistantMsg.senseCalls?.length || 0);
    }

    // sense 结果（独立追加，不受 assistant 消息条件限制）
    for (const r of this.senseResults) {
      const senseMsg = {
        id: r.id,
        role: "sense",
        content: r.type === "sense_accept" ? r.result : `被拒绝: ${r.reason}`,
        createdAt: Date.now(),
        updateAt: Date.now(),
      };
      messages.push(senseMsg);

      newMessages.push({
        id: r.id,
        role: "sense",
        content: senseMsg.content,
      });

      logger.info("\n[CHECKPOINT] ⚡ Appended sense message");
      logger.info("[CHECKPOINT] Type:", r.type);
      logger.info("[CHECKPOINT] ID:", r.id);
      logger.info("[CHECKPOINT] Content preview:", senseMsg.content.slice(0, 100));
      logger.info("[CHECKPOINT] ⚠️ This will affect loop.ts decision!");
      logger.info("[CHECKPOINT] If type=sense_reject, loop will check: role==='sense' → continue");
    }

    ctx.soul.messages = messages;
    logger.info("[CHECKPOINT] Total messages:", messages.length);
    logger.info("[CHECKPOINT] Last message role:", messages[messages.length - 1]?.role);
    logger.info();

    return newMessages;
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

  /**
   * 重置状态（sense_complete 后新一轮）
   */
  reset(): void {
    this.thinking = "";
    this.content = "";
    this.senseDeltas = [];
    // 不重置 pendingSenses 和 senseResults（跨轮次保持）
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