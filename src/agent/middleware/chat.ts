import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
  RuntimeConfig,
} from "@/core/middleware/types";
import type { SenseFunction, SenseCallData } from "@/core/sense/adapter";
import type { LLMOptions } from "@/core/llm/adapter";
import { logger } from "@/utils/logger/index.js";

/**
 * Chat Middleware
 * 职责：API 调用、流式输出
 * yield StreamChunk（包含 senseDelta）
 * sense_end 逻辑交给 checkpoint 中间件处理
 */
export async function* chatMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  // P2-4：runtime 在 send 前 configureRuntime 注入；运行时守卫窄化，消除构造期 {} as 谎言
  if (!ctx.runtime) throw new Error("Runtime not configured. Call configureRuntime() before send().");
  const { llmAdapter, messageAdapter, senseAdapter } = ctx.runtime.adapters;

  // 从 ctx.soul.messages 构建 provider 格式消息
  const messages = messageAdapter.buildMessages(ctx.soul.messages || []);

  // 使用预构建的 senses（runtime.builtSenses）
  const senses = ctx.runtime.builtSenses;

  // 构建请求选项（P1-6：LLMOptions 显式类型，替代 Record<string, unknown>）
  const options: LLMOptions = {
    model: ctx.runtime.brain.model,
    url: ctx.runtime.brain.url,
    key: ctx.runtime.brain.key,
    ...(ctx.runtime.brain.thinking && { thinking: true }),
    ...(ctx.runtime.brain.rpm && { rpm: ctx.runtime.brain.rpm }),
  };

  // ========== AI 输入参数日志 ==========
  logger.event("llm.req", {
    provider: ctx.runtime.brain.provider || "unknown",
    model: options.model,
    thinking: !!options.thinking,
    stream: !!ctx.global.stream,
    senseCount: senses.length,
    senseNames: senses.map((s) => s.function?.name || "unknown"),
    msgCount: messages.length,
  });

  if (ctx.global.stream) {
    // 流式调用
    yield* handleStream(
      options,
      llmAdapter,
      messageAdapter,
      senseAdapter,
      messages,
      senses,
    );
  } else {
    // 非流式调用
    yield* handleNonStream(
      options,
      llmAdapter,
      messageAdapter,
      senseAdapter,
      messages,
      senses,
    );
  }

  // 执行下游
  yield* next();
}

/**
 * 处理流式调用
 */
async function* handleStream(
  options: LLMOptions,
  llmAdapter: RuntimeConfig["adapters"]["llmAdapter"],
  messageAdapter: RuntimeConfig["adapters"]["messageAdapter"],
  senseAdapter: RuntimeConfig["adapters"]["senseAdapter"],
  messages: unknown[],
  senses: SenseFunction[],
): AsyncGenerator<StreamChunk> {
  const streamIterator = await llmAdapter.chatStream(messages, senses, options);

  let chunkCount = 0;
  let thinkingAccumulated = "";
  let contentAccumulated = "";
  let senseCallsAccumulated: SenseCallData[] = [];

  for await (const rawChunk of streamIterator) {
    chunkCount++;

    // 提取增量
    const thinkingDelta =
      messageAdapter.extractStreamThinking?.(rawChunk) || "";
    const contentDelta = messageAdapter.extractStreamDelta?.(rawChunk) || "";

    // 提取 sense call 增量
    const senseDelta = senseAdapter.extractSenseCallDeltas(rawChunk);

    // 累积内容（用于完成时汇总事件）
    thinkingAccumulated += thinkingDelta;
    contentAccumulated += contentDelta;
    if (senseDelta.length > 0) {
      senseCallsAccumulated.push(...senseDelta);
    }

    // yield stream chunk（包含 senseDelta）
    if (thinkingDelta || contentDelta || senseDelta.length > 0) {
      yield {
        type: "stream",
        thinkingDelta,
        contentDelta,
        senseDelta: senseDelta.length > 0 ? senseDelta : undefined,
      };
    }
  }

  // ========== 流式响应完成 ==========
  logger.event("llm.resp", {
    mode: "stream",
    chunks: chunkCount,
    thinkingLen: thinkingAccumulated.length,
    contentLen: contentAccumulated.length,
    senseCalls: senseCallsAccumulated.length,
  });
}

/**
 * 处理非流式调用
 */
async function* handleNonStream(
  options: LLMOptions,
  llmAdapter: RuntimeConfig["adapters"]["llmAdapter"],
  messageAdapter: RuntimeConfig["adapters"]["messageAdapter"],
  senseAdapter: RuntimeConfig["adapters"]["senseAdapter"],
  messages: unknown[],
  senses: SenseFunction[],
): AsyncGenerator<StreamChunk> {
  const response = await llmAdapter.chat(messages, senses, options);

  // 提取内容和思考
  const content = messageAdapter.content(response);
  const thinking = messageAdapter.thinking?.(response);

  // 提取 sense calls（非流式为完整数据）
  const senseDelta = senseAdapter.senseCalls(response);

  // ========== 非流式响应汇总 ==========
  logger.event("llm.resp", {
    mode: "non-stream",
    thinkingLen: thinking?.length ?? 0,
    contentLen: content?.length ?? 0,
    senseCalls: senseDelta.length,
  });

  // yield stream chunk（包含 senseDelta）
  if (content || thinking || senseDelta.length > 0) {
    yield {
      type: "stream",
      thinkingDelta: thinking || "",
      contentDelta: content || "",
      senseDelta: senseDelta.length > 0 ? senseDelta : undefined,
    };
  }
}

export default chatMiddleware;