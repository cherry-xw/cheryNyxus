import { randomUUID } from "crypto";
import type { MiddlewareContext, MiddlewareChunk, StreamChunk, StagedChunk, SenseTriggerChunk } from "@/core/middleware/types";
import { CheckpointState } from "./checkpointState.js";

/**
 * 持久化消息到 DB（通过回调）
 */
function persistMessage(ctx: MiddlewareContext, msg: Parameters<NonNullable<MiddlewareContext["persistMessage"]>>[0]): void {
  if (ctx.persistMessage) {
    ctx.persistMessage(msg);
  }
}

/**
 * Checkpoint Middleware
 * 职责：
 * 1. 处理 userInputs → messages（在 next() 调用前）
 * 2. 接收所有 chunk，归纳状态
 * 3. 收集 senseDelta，合并后 yield sense_end staged
 * 4. 构建 messages 放到 ctx.soul
 * 5. 管理 pendingSenses
 * 6. 持久化关键状态
 * 7. yield consumed notification
 * 8. 边界检测：thinking_end / content_end / sense_end 三种 staged
 */
export async function* checkpointMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // === 先处理 userInputs：转为 messages（在 next() 调用前）===
  const userInputs = ctx.soul.userInputs;
  let consumedCount = 0;  // 追踪消费的用户输入数量

  if (userInputs.length > 0) {
    const messages = ctx.soul.messages ?? [];
    for (const input of userInputs) {
      const msgId = randomUUID();
      messages.push({
        id: msgId,
        role: "user",
        content: input.content,
        createdAt: input.time, // 用户发送时间
        updateAt: Date.now(), // 注入消息列表时间
      });
      consumedCount++;

      // 实时持久化 user 消息（连接中断也不丢失）
      persistMessage(ctx, { id: msgId, role: "user", content: input.content });
    }
    ctx.soul.messages = messages;
    // 清空 userInputs（避免重复处理）
    userInputs.length = 0;

    // yield consumed notification（注入时立即通知）
    yield {
      type: "consumed",
      count: consumedCount,
    } as MiddlewareChunk;
  }

  const state = new CheckpointState();
  // 三 delta 状态机标记
  let thinkingActive = false;  // thinkingDelta 是否活跃
  let contentActive = false;   // contentDelta 是否活跃

  // === 执行内层 handlers ===
  try {
    for await (const chunk of next()) {
      state.ingest(chunk);

      // 边界检测和 staged yield（三 delta 状态机）
      if (chunk.type === "stream") {
        const streamChunk = chunk as StreamChunk;

        // thinkingDelta 出现 → thinkingActive = true
        if (streamChunk.thinkingDelta) {
          thinkingActive = true;
        }

        // contentDelta 出现 → thinking 结束，content 开始
        if (streamChunk.contentDelta) {
          // 如果 thinking 活跃，先 yield thinking_end staged
          if (thinkingActive) {
            thinkingActive = false;
            const thinkingStaged: StagedChunk = {
              type: "staged",
              stagedType: "thinking_end",
              content: "",
              thinking: state.getThinking(),
            };
            yield thinkingStaged;
          }
          contentActive = true;
        }

        // senseDelta 出现 → content 结束，sense 开始
        if (streamChunk.senseDelta && streamChunk.senseDelta.length > 0) {
          // 如果 thinking 活跃，先 yield thinking_end staged
          if (thinkingActive) {
            thinkingActive = false;
            const thinkingStaged: StagedChunk = {
              type: "staged",
              stagedType: "thinking_end",
              content: "",
              thinking: state.getThinking(),
            };
            yield thinkingStaged;
          }

          // 如果 content 活跃，yield content_end staged
          if (contentActive) {
            contentActive = false;
            const contentStaged: StagedChunk = {
              type: "staged",
              stagedType: "content_end",
              content: state.getContent(),
              thinking: "",
            };
            yield contentStaged;
          }
        }
      }

      // sense_end 时重置状态标记
      if (chunk.type === "sense_end") {
        const trigger = chunk as SenseTriggerChunk;
        // yield sense_end staged
        const senseStaged: StagedChunk = {
          type: "staged",
          stagedType: "sense_end",
          content: "",
          thinking: "",
          senseName: trigger.name,
          senseArguments: trigger.arguments,
        };
        yield senseStaged;
      }

      // sense_complete 时不重置标记（本轮 thinking/content 已 yield）
      // 新一轮标记由新 CheckpointState 初始化

      yield chunk;
    }

    // === 流结束后 yield 最终 staged（仅正常完成时） ===
    if (thinkingActive) {
      yield {
        type: "staged",
        stagedType: "thinking_end",
        content: "",
        thinking: state.getThinking(),
      } as StagedChunk;
      thinkingActive = false;
    }
    if (contentActive) {
      yield {
        type: "staged",
        stagedType: "content_end",
        content: state.getContent(),
        thinking: "",
      } as StagedChunk;
      contentActive = false;
    }
  } finally {
    // === 始终执行：追加消息 + 持久化（即使 generator.return() 也会运行） ===
    const newMessages = state.appendResponseMessages(ctx);
    for (const msg of newMessages) {
      persistMessage(ctx, msg);
    }
  }

  // 不再 yield done（由 loop.ts 负责）
}

export default checkpointMiddleware;