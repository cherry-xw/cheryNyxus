import type { MiddlewareContext, MiddlewareChunk, StreamChunk, DoneChunk } from "./types";
import { getLLMAdapter } from "@/llm/adapter";
import { getMessageProviderAdapterConfig } from "@/message/adapter";
import { getToolAdapter } from "@/tool/adapter";

/**
 * Chat Middleware
 * 职责：API 调用、流式/非流式切换
 * 从 history 构建 provider 格式消息
 */
export async function* chatMiddleware(
  ctx: MiddlewareContext,
  next: () => Promise<void> | AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  const llmAdapter = getLLMAdapter(ctx.config.provider);
  if (!llmAdapter) {
    throw new Error(`Provider "${ctx.config.provider}" adapter not registered`);
  }

  // 从 history 构建 provider 格式消息
  const msgAdapter = getMessageProviderAdapterConfig(ctx.config.provider);
  if (!msgAdapter) {
    throw new Error(`Provider "${ctx.config.provider}" message adapter not registered`);
  }
  const messages = msgAdapter.buildMessages(ctx.history);

  // 构建 tools（从 toolManager）
  const toolAdapter = getToolAdapter(ctx.config.provider);
  const tools = ctx.toolManager.getAll().length > 0 && toolAdapter
    ? toolAdapter.buildTools(ctx.toolManager.getAll())
    : [];

  // 构建请求选项（传递必要参数）
  ctx.options = {
    model: ctx.config.model,
    url: ctx.config.url,
    key: ctx.config.key,
    ...(ctx.config.thinking && { thinking: true }),
  };

  if (ctx.isStream) {
    // 流式调用
    yield* handleStream(ctx, llmAdapter, messages, tools);
  } else {
    // 非流式调用
    yield* handleNonStream(ctx, llmAdapter, messages, tools);
  }
}

/**
 * 处理流式调用
 */
async function* handleStream(
  ctx: MiddlewareContext,
  llmAdapter: ReturnType<typeof getLLMAdapter>,
  messages: unknown[],
  tools: unknown[],
): AsyncGenerator<MiddlewareChunk> {
  // 打印入参信息
  console.log("\n=== Chat Stream Request ===");
  console.log("Messages:", JSON.stringify(messages, null, 2));
  console.log("Tools:", JSON.stringify(tools, null, 2));
  console.log("Options:", JSON.stringify(ctx.options, null, 2));

  const streamIterator = await llmAdapter!.chatStream(
    messages,
    tools,
    ctx.options,
  );

  ctx.streamIterator = streamIterator;

  console.log("\n=== Chat Stream Raw Chunks ===");
  for await (const rawChunk of streamIterator) {
    console.log(JSON.stringify(rawChunk, null, 2));
    const chunk: StreamChunk = {
      type: "stream",
      streamId: `stream-${Date.now()}`,
      thinkingDelta: "",
      delta: "",
      thinkingAccumulated: "",
      accumulated: "",
      raw: rawChunk,
    };
    yield chunk;
  }
}

/**
 * 处理非流式调用
 */
async function* handleNonStream(
  ctx: MiddlewareContext,
  llmAdapter: ReturnType<typeof getLLMAdapter>,
  messages: unknown[],
  tools: unknown[],
): AsyncGenerator<MiddlewareChunk> {
  // 打印入参信息
  console.log("\n=== Chat Request ===");
  console.log("Messages:", JSON.stringify(messages, null, 2));
  console.log("Tools:", JSON.stringify(tools, null, 2));
  console.log("Options:", JSON.stringify(ctx.options, null, 2));

  const response = await llmAdapter!.chat(
    messages,
    tools,
    ctx.options,
  );

  ctx.response = response;

  // 打印原始响应
  console.log("\n=== Chat Raw Response ===");
  console.log(JSON.stringify(response, null, 2));

  // 通过 MessageAdapter 提取内容和思考
  const msgAdapter = getMessageProviderAdapterConfig(ctx.config.provider);
  if (!msgAdapter) {
    throw new Error(`Provider "${ctx.config.provider}" message adapter not registered`);
  }

  const content = msgAdapter.content(response);
  const thinking = msgAdapter.thinking?.(response);

  const chunk: DoneChunk = {
    type: "done",
    content,
    thinking,
    threadId: ctx.threadId,
    raw: response,
  };
  yield chunk;
}