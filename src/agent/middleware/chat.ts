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
  };

  // ========== AI 输入参数日志 ==========
  logger.info("\n" + "=".repeat(60));
  logger.info("[AI INPUT] LLM Request");
  logger.info("=".repeat(60));
  logger.info("[Provider]", ctx.runtime.brain.provider || "unknown");
  logger.info("[Model]", options.model);
  logger.info("[Thinking]", options.thinking ? "enabled" : "disabled");
  logger.info("[Stream]", ctx.global.stream ? "enabled" : "disabled");
  logger.info("[Senses]", senses.length, "available");
  if (senses.length > 0) {
    logger.info("[Sense Names]", senses.map(s => s.function?.name || "unknown").join(", "));
  }
  logger.info("\n[Messages]");
  logger.info(JSON.stringify(messages, null, 2));
  logger.info("=".repeat(60) + "\n");

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
  logger.info("[AI OUTPUT] Stream Response Started");
  logger.info("-".repeat(60));

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

    // 累积内容（用于最终日志）
    thinkingAccumulated += thinkingDelta;
    contentAccumulated += contentDelta;
    if (senseDelta.length > 0) {
      senseCallsAccumulated.push(...senseDelta);
    }

    // 每 10 个 chunk 打印一次增量摘要
    if (chunkCount % 10 === 0) {
      logger.info(`[Chunk ${chunkCount}] thinking:${thinkingAccumulated.length} chars, content:${contentAccumulated.length} chars, senses:${senseCallsAccumulated.length}`);
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

  // ========== 流式响应完成日志 ==========
  logger.info("\n" + "-".repeat(60));
  logger.info("[AI OUTPUT] Stream Response Complete");
  logger.info("[Total Chunks]", chunkCount);
  logger.info("\n[Thinking Accumulated]");
  logger.info(thinkingAccumulated || "(none)");
  logger.info("\n[Content Accumulated]");
  logger.info(contentAccumulated || "(none)");
  if (senseCallsAccumulated.length > 0) {
    logger.info("\n[Sense Calls Accumulated]");
    logger.info(JSON.stringify(senseCallsAccumulated, null, 2));
  }
  logger.info("-".repeat(60) + "\n");
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
  logger.info("[AI OUTPUT] Non-Stream Response");
  logger.info("-".repeat(60));

  const response = await llmAdapter.chat(messages, senses, options);

  // 提取内容和思考
  const content = messageAdapter.content(response);
  const thinking = messageAdapter.thinking?.(response);

  // 提取 sense calls（非流式为完整数据）
  const senseDelta = senseAdapter.senseCalls(response);

  // ========== 非流式响应日志 ==========
  logger.info("\n[Thinking]");
  logger.info(thinking || "(none)");
  logger.info("\n[Content]");
  logger.info(content || "(none)");
  if (senseDelta.length > 0) {
    logger.info("\n[Sense Calls]");
    logger.info(JSON.stringify(senseDelta, null, 2));
  }
  logger.info("\n[Raw Response]");
  logger.info(JSON.stringify(response, null, 2));
  logger.info("-".repeat(60) + "\n");

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