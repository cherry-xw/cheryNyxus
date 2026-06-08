import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
} from "@/core/middleware/types";
import type { SenseFunction } from "@/core/sense/adapter";

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
  const { llmAdapter, messageAdapter, senseAdapter } = ctx.adapters;

  // 从 ctx.soul.messages 构建 provider 格式消息
  const messages = messageAdapter.buildMessages(ctx.soul.messages || []);

  // 使用预构建的 senses（builder 层一次性构建）
  const senses = ctx.soul.builtSenses;

  // 构建请求选项
  const options = {
    model: ctx.brain.model,
    url: ctx.brain.url,
    key: ctx.brain.key,
    ...(ctx.brain.thinking && { thinking: true }),
  };

  if (ctx.global.stream) {
    // 流式调用
    yield* handleStream(
      ctx,
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
      ctx,
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
  ctx: MiddlewareContext,
  options: Record<string, unknown>,
  llmAdapter: MiddlewareContext["adapters"]["llmAdapter"],
  messageAdapter: MiddlewareContext["adapters"]["messageAdapter"],
  senseAdapter: MiddlewareContext["adapters"]["senseAdapter"],
  messages: unknown[],
  senses: SenseFunction[],
): AsyncGenerator<StreamChunk> {
  const streamIterator = await llmAdapter.chatStream(messages, senses, options);

  for await (const rawChunk of streamIterator) {
    // 提取增量
    const thinkingDelta =
      messageAdapter.extractStreamThinking?.(rawChunk) || "";
    const contentDelta = messageAdapter.extractStreamDelta?.(rawChunk) || "";

    // 提取 sense call 增量
    const senseDelta = senseAdapter.extractSenseCallDeltas(rawChunk);

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
}

/**
 * 处理非流式调用
 */
async function* handleNonStream(
  ctx: MiddlewareContext,
  options: Record<string, unknown>,
  llmAdapter: MiddlewareContext["adapters"]["llmAdapter"],
  messageAdapter: MiddlewareContext["adapters"]["messageAdapter"],
  senseAdapter: MiddlewareContext["adapters"]["senseAdapter"],
  messages: unknown[],
  senses: SenseFunction[],
): AsyncGenerator<StreamChunk> {
  const response = await llmAdapter.chat(messages, senses, options);

  // 提取内容和思考
  const content = messageAdapter.content(response);
  const thinking = messageAdapter.thinking?.(response);

  // 提取 sense calls（非流式为完整数据）
  const senseDelta = senseAdapter.senseCalls(response);

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