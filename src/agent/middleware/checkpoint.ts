import { randomUUID } from "crypto";
import type {
  AgentMessage,
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
  StagedChunk,
  SenseTriggerChunk,
} from "@/core/middleware/types";
import { CheckpointState } from "./checkpointState.js";

/**
 * Checkpoint Middleware
 * 职责：
 * 1. 处理 userInputs → messages（在 next() 调用前）
 * 2. 接收所有 chunk，归纳状态
 * 3. 收集 senseDelta，合并后 yield sense_end staged
 * 4. 构建 messages 放到 ctx.soul
 * 5. yield message/sense effect chunk，由 service observer 处理副作用
 * 6. yield consumed notification
 * 7. 边界检测：thinking_end / content_end / sense_end 三种 staged
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
    const consumedMessages: AgentMessage[] = [];
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
      consumedMessages.push({
        id: msgId,
        role: "user",
        content: input.content,
      });
    }
    ctx.soul.messages = messages;
    // 清空 userInputs（避免重复处理）
    userInputs.length = 0;

    for (const message of consumedMessages) {
      yield {
        type: "message_created",
        message,
      } as MiddlewareChunk;
    }

    // yield consumed notification（注入时立即通知）
    yield {
      type: "consumed",
      count: consumedCount,
      messages: consumedMessages,
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
          id: trigger.id,
        };
        yield senseStaged;

        // 先 flush 本轮 assistant（content/thinking/senseCalls 已完整），在 pending sense 前 push，
        // 保证消息顺序 [user, assistant, sense]；sense_end 在 for-await 循环内，abort 时 effect 已被
        // observer 消费落库（finally 的 yield 在 gen.return 下死锁，不可依赖）。
        const flushedAssistant = state.flushAssistant(ctx);
        if (flushedAssistant) {
          yield {
            type: "message_created",
            message: flushedAssistant,
          } as MiddlewareChunk;
        }

        // confirm/manual 模式：创建 pending sense 消息（若不存在），并 yield effect 交给 service 持久化。
        // resume 续接时 pending 已存在（同 trigger.id）→ 跳过创建，仅注册审批避免重复落库。
        if (trigger.supervisionLevel > 0 /* SupervisionLevel.auto */) {
          const messages = ctx.soul.messages ?? [];
          const exists = messages.some(m => m.id === trigger.id);
          if (!exists) {
            const senseMsg = {
              id: trigger.id,
              role: "sense" as const,
              content: "",
              senseCalls: [{ id: trigger.id, name: trigger.name, arguments: trigger.arguments }],
              createdAt: Date.now(),
              updateAt: Date.now(),
            };
            messages.push(senseMsg);
            ctx.soul.messages = messages;

            yield {
              type: "message_created",
              message: {
                id: senseMsg.id,
                role: "sense",
                content: "",
                senseCalls: senseMsg.senseCalls,
              },
            } as MiddlewareChunk;
          }

          // 始终注册审批（resume 时 pending 已存在，仅注册 approvalManager）
          yield {
            type: "sense_pending",
            approvalId: trigger.id,
            senseName: trigger.name,
            arguments: trigger.arguments,
            supervisionLevel: trigger.supervisionLevel,
            approvalResolve: trigger.approvalResolve,
            approvalReject: trigger.approvalReject,
          } as MiddlewareChunk;
        }
      }

      // sense_accept/sense_reject 时不重置标记（本轮 thinking/content 已 yield）
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
    // === 追加消息 + yield effect，由外层 observer 统一处理副作用 ===
    const mutations = state.appendResponseMessages(ctx);
    for (const mutation of mutations) {
      if (mutation.type === "created") {
        yield {
          type: "message_created",
          message: mutation.message,
        } as MiddlewareChunk;
      } else {
        yield {
          type: "message_updated",
          id: mutation.id,
          patch: mutation.patch,
        } as MiddlewareChunk;
      }
    }
  }

  // 不再 yield done（由 loop.ts 负责）
}

export default checkpointMiddleware;
