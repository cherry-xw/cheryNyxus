import { randomUUID } from "crypto";
import type { MiddlewareContext, MiddlewareChunk } from "@/core/middleware/types";
import { checkpointRepo } from "@/db/checkpoint.js";
import { CheckpointState } from "./checkpointState.js";

/**
 * Checkpoint Middleware
 * 职责：
 * 1. 处理 userInputs → messages（在 next() 调用前）
 * 2. 接收所有 chunk，归纳状态
 * 3. 收集 toolDelta，合并后 yield tool_trigger
 * 4. 构建 messages 放到 ctx.session
 * 5. 管理 pendingTools
 * 6. 持久化关键状态
 * 7. yield consumed notification
 */
export async function* checkpointMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // === 先处理 userInputs：转为 messages（在 next() 调用前）===
  const userInputs = ctx.session.userInputs;
  let consumedCount = 0;  // 追踪消费的用户输入数量

  if (userInputs.length > 0) {
    const messages = ctx.session.messages ?? [];
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
    ctx.session.messages = messages;
    // 清空 userInputs（避免重复处理）
    userInputs.length = 0;
  }

  const state = new CheckpointState();

  // === 执行内层 handlers ===
  for await (const chunk of next()) {
    state.ingest(chunk);
    yield chunk;
  }

  // === yield staged ===
  const staged = state.getStagedData();
  yield {
    type: "staged",
    content: staged.content,
    thinking: staged.thinking,
  };

  // === 追加 assistant 响应和 tool 结果到 messages ===
  state.appendResponseMessages(ctx);

  // === yield consumed notification（如有消费）===
  if (consumedCount > 0) {
    yield {
      type: "consumed",
      count: consumedCount,
    } as MiddlewareChunk;
  }

  // === 持久化 checkpoint ===
  await checkpointRepo.create({
    id: randomUUID(),
    sessionId: ctx.session.sessionId,
    threadId: ctx.session.threadId,
    phase: "complete",
    pendingTools: JSON.stringify(state.getPendingToolsArray()),
    thinkingAccumulated: state.getThinking(),
    contentAccumulated: state.getContent(),
    messages: JSON.stringify(ctx.session.messages),
    createdAt: Date.now(),
  });

  yield { type: "done" };
}

export default checkpointMiddleware;