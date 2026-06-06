import { randomUUID } from "crypto";
import type { MiddlewareContext, MiddlewareChunk, StreamChunk } from "@/core/middleware/types";
import { checkpointRepo } from "@/db/checkpoint.js";
import { CheckpointState } from "./checkpointState.js";

/**
 * Checkpoint Middleware
 * 职责：
 * 1. 处理 userInputs → messages（在 next() 调用前）
 * 2. 接收所有 chunk，归纳状态
 * 3. 收集 senseDelta，合并后 yield sense_trigger
 * 4. 构建 messages 放到 ctx.soul
 * 5. 管理 pendingSenses
 * 6. 持久化关键状态
 * 7. yield consumed notification
 * 8. 边界检测：思考结束时 yield staged(thinking)，正文结束后 yield staged(content)
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
      messages.push({
        id: randomUUID(),
        role: "user",
        content: input.content,
        createdAt: input.time,
        updateAt: input.time,
      });
      consumedCount++;
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
  let thinkingStagedYielded = false;  // 标记思考阶段 staged 是否已 yield
  let hasThinkingAccumulated = false; // 标记是否有累积的思考内容

  // === 执行内层 handlers ===
  for await (const chunk of next()) {
    state.ingest(chunk);

    // 边界检测：思考结束 → 正文开始的转换点
    if (chunk.type === "stream") {
      const streamChunk = chunk as StreamChunk;

      // 检测是否有累积的思考
      if (streamChunk.thinkingDelta) {
        hasThinkingAccumulated = true;
      }

      // 检测思考→正文边界：首次出现 contentDelta 且有累积思考
      if (!thinkingStagedYielded && hasThinkingAccumulated && streamChunk.contentDelta) {
        thinkingStagedYielded = true;
        // yield 思考阶段的 staged
        yield {
          type: "staged",
          content: "",
          thinking: state.getThinking(),
        } as MiddlewareChunk;
      }
    }

    yield chunk;
  }

  // === yield 正文阶段的 staged ===
  const staged = state.getStagedData();
  // 如果没有 yield 思考 staged（即只有正文没有思考），则 yield 完整 staged
  // 如果已经 yield 思考 staged，则只 yield 正文 staged
  if (!thinkingStagedYielded) {
    // 无思考或有思考但无边界转换（只有思考无正文）
    yield {
      type: "staged",
      content: staged.content,
      thinking: staged.thinking,
    };
  } else if (staged.content) {
    // 有正文内容，yield 正文 staged
    yield {
      type: "staged",
      content: staged.content,
      thinking: "",
    } as MiddlewareChunk;
  }

  // === 追加 assistant 响应和 sense 结果到 messages ===
  state.appendResponseMessages(ctx);

  // === 持久化 checkpoint ===
  await checkpointRepo.create({
    id: randomUUID(),
    soulId: ctx.soul.soulId,
    chatId: ctx.soul.chatId,
    phase: "complete",
    pendingSenses: JSON.stringify(state.getPendingSensesArray()),
    thinkingAccumulated: state.getThinking(),
    contentAccumulated: state.getContent(),
    messages: JSON.stringify(ctx.soul.messages),
    createdAt: Date.now(),
  });

  yield { type: "done" };
}

export default checkpointMiddleware;