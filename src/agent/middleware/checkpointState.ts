import { randomUUID } from "crypto";
import type {
  AgentMessage,
  AgentMessagePatch,
  MiddlewareContext,
  SenseAcceptChunk,
  SenseRejectChunk,
} from "@/core/middleware/types";
import type { LLMResponse } from "@/core/message/adapter";
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
  private senseResults: (SenseAcceptChunk | SenseRejectChunk)[] = [];
  /** 本轮 assistant 是否已在 sense_end 时 flush（避免 finally 重复 push） */
  private assistantFlushed = false;

  /**
   * 摄入 chunk，更新内部状态
   */
  ingest(chunk: { type: string; thinkingDelta?: string; contentDelta?: string; senseDelta?: SenseCallData[]; id?: string; name?: string; arguments?: string; result?: string; reason?: string; hash?: string }): void {
    switch (chunk.type) {
      case "stream":
        this.thinking += chunk.thinkingDelta ?? "";
        this.content += chunk.contentDelta ?? "";
        if (chunk.senseDelta) {
          this.senseDeltas.push(...chunk.senseDelta);
        }
        break;

      case "sense_accept":
      case "sense_reject":
        this.senseResults.push(chunk as SenseAcceptChunk | SenseRejectChunk);
        break;
    }
  }

  /**
   * 在 sense_end 时增量构建并 push 本轮 assistant（content/thinking/senseCalls 已完整）。
   *
   * 为什么不只在 finally 构建：
   * 1. 顺序：pending sense 在 sense_end push，assistant 若在 finally push 会排在 sense 之后
   *    （[user, sense, assistant]），破坏 LLM 消息顺序（assistant 应在 tool result 前），
   *    导致 revokeTrailingCycle 找不到前置 assistant、resume Case1 判定错误。
   * 2. abort 落库：sense_end 在 for-await 循环内，yield message_created effect 被 observer
   *    正常消费落库。abort 时此路径已执行，assistant 已在 DB（finally 的 yield 在 gen.return
   *    传播下会死锁不执行，不可依赖）。
   *
   * @returns AgentMessage（供 checkpoint yield message_created effect）；本轮无内容或已 flush 返回 null
   */
  flushAssistant(ctx: MiddlewareContext): AgentMessage | null {
    if (this.assistantFlushed) return null;
    const mergedSenseCalls = mergeSenseDeltas(this.senseDeltas);
    if (!this.content && !this.thinking && mergedSenseCalls.length === 0) return null;

    const messages = ctx.soul.messages ?? [];
    const senseCalls = mergedSenseCalls
      .filter((sc) => sc.name)
      .map((sc) => ({ id: sc.id, name: sc.name!, arguments: sc.arguments }));
    const assistantMsg: LLMResponse = {
      id: randomUUID(),
      role: "assistant" as const,
      content: this.content,
      thinking: this.thinking,
      senseCalls,
      createdAt: Date.now(),
      updateAt: Date.now(),
    };
    messages.push(assistantMsg);
    ctx.soul.messages = messages;
    this.assistantFlushed = true;

    return {
      id: assistantMsg.id,
      role: "assistant",
      content: this.content || undefined,
      thinking: this.thinking || undefined,
      senseCalls,
    };
  }

  /**
   * 追加 assistant 响应和 sense 结果到 messages
   * （userInputs 已在 checkpoint.ts next() 调用前处理）
   * @returns 消息变更列表（由 checkpoint 发送事件）
   */
  appendResponseMessages(ctx: MiddlewareContext): CheckpointMessageMutation[] {
    const mergedSenseCalls = mergeSenseDeltas(this.senseDeltas);
    const messages = ctx.soul.messages ?? [];
    const mutations: CheckpointMessageMutation[] = [];

    logger.info("\n[CHECKPOINT] Appending response messages");
    logger.info("[CHECKPOINT] Thinking length:", this.thinking.length);
    logger.info("[CHECKPOINT] Content length:", this.content.length);
    logger.info("[CHECKPOINT] Sense deltas:", this.senseDeltas.length);
    logger.info("[CHECKPOINT] Merged sense calls:", mergedSenseCalls.length);
    logger.info("[CHECKPOINT] Sense results:", this.senseResults.length);

    // assistant 响应（包含 thinking 和 senseCalls）
    // sense_call 流已在 sense_end 时 flush（assistantFlushed=true），此处跳过避免重复 push；
    // 仅纯 content/thinking 流（未触发 sense_end）在此构建。
    if (!this.assistantFlushed && (this.content || this.thinking || mergedSenseCalls.length > 0)) {
      const assistantMsg: LLMResponse = {
        id: randomUUID(),
        role: "assistant" as const,
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
      mutations.push({
        type: "created",
        message: {
          id: assistantMsg.id,
          role: "assistant",
          content: this.content || undefined,
          thinking: this.thinking || undefined,
          senseCalls: assistantMsg.senseCalls,
        },
      });
      logger.info("[CHECKPOINT] ✅ Appended assistant message");
      logger.info("[CHECKPOINT] Sense calls in assistant:", assistantMsg.senseCalls?.length || 0);
    }

    // sense 结果（独立追加，不受 assistant 消息条件限制）
    for (const r of this.senseResults) {
      const hash = r.type === "sense_accept" ? r.hash : undefined;

      const content = r.type === "sense_accept" ? r.result : `被拒绝: ${r.reason}`;

      // 检测是否为 recovery 场景（消息已存在于 context 中）
      const existingIdx = messages.findIndex(m => m.id === r.id);
      if (existingIdx !== -1) {
        // Recovery: 原地更新已有消息（已在 DB，不 INSERT）
        const existing = messages[existingIdx]!;
        existing.content = content;
        if (hash) existing.hash = hash;
        existing.updateAt = Date.now();

        logger.info("\n[CHECKPOINT] 🔄 Updated existing sense message (recovery)");
        logger.info("[CHECKPOINT] Type:", r.type);
        logger.info("[CHECKPOINT] ID:", r.id);
        logger.info("[CHECKPOINT] Content preview:", content.slice(0, 100));

        mutations.push({
          type: "updated",
          id: r.id,
          patch: {
            content,
            hash,
          },
        });
      } else {
        // Normal: 创建新消息并 INSERT
        const senseMsg: LLMResponse = {
          id: r.id,
          role: "sense",
          content,
          hash,
          createdAt: Date.now(),
          updateAt: Date.now(),
        };
        messages.push(senseMsg);

        mutations.push({
          type: "created",
          message: {
            id: r.id,
            role: "sense",
            content: senseMsg.content,
            hash,
          },
        });

        logger.info("\n[CHECKPOINT] ⚡ Appended sense message");
        logger.info("[CHECKPOINT] Type:", r.type);
        logger.info("[CHECKPOINT] ID:", r.id);
        logger.info("[CHECKPOINT] Hash:", hash || "(none)");
        logger.info("[CHECKPOINT] Content preview:", content.slice(0, 100));
      }
    }

    ctx.soul.messages = messages;
    logger.info("[CHECKPOINT] Total messages:", messages.length);
    logger.info("[CHECKPOINT] Last message role:", messages[messages.length - 1]?.role);
    logger.info();

    return mutations;
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

export type CheckpointMessageMutation =
  | {
      type: "created";
      message: AgentMessage;
    }
  | {
      type: "updated";
      id: string;
      patch: AgentMessagePatch;
    };

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
