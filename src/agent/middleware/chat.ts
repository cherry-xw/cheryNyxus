import type { MiddlewareContext } from "@/core/middleware/types";
import type { StagedChunk, StreamChunk } from "./chunk";
import type { ToolFunction } from "@/core/tool";

/**
 * Chat Middleware
 * 职责：API 调用、流式/非流式切换
 * 从 history 构建 provider 格式消息
 */
export async function* chatMiddleware(
  ctx: MiddlewareContext,
  _next: () => AsyncGenerator<unknown>,
): AsyncGenerator<StreamChunk | StagedChunk> {
  const { llmAdapter, messageAdapter, toolAdapter } = ctx.adapters;

  // 从 history 构建 provider 格式消息
  const messages = messageAdapter.buildMessages(ctx.process.history);

  // 构建 tools（从 toolManager）
  const tools =
    ctx.tools.toolManager.getAll().length > 0
      ? toolAdapter.buildTools(ctx.tools.toolManager.getAll())
      : [];

  // 构建请求选项（传递必要参数）
  const options = {
    model: ctx.config.model,
    url: ctx.config.url,
    key: ctx.config.key,
    ...(ctx.config.thinking && { thinking: true }),
  };

  if (ctx.global.stream) {
    // 流式调用
    yield* handleStream(options, llmAdapter, messages, tools);
  } else {
    // 非流式调用
    yield* handleNonStream(ctx, options, llmAdapter, messages, tools);
  }
}

/**
 * 处理流式调用
 */
async function* handleStream(
  options: Record<string, unknown>, // LLM请求选项（model/url/key/thinking等）
  llmAdapter: MiddlewareContext["adapters"]["llmAdapter"],
  messages: unknown[],
  tools: ToolFunction[],
): AsyncGenerator<StreamChunk> {
  // 打印入参信息
  // console.log("\n=== Chat Stream Request ===");
  // console.log("Messages:", JSON.stringify(messages, null, 2));
  // console.log("Tools:", JSON.stringify(tools, null, 2));

  const streamIterator = await llmAdapter.chatStream(messages, tools, options);

  for await (const rawChunk of streamIterator) {
    const chunk: StreamChunk = {
      type: "stream",
      thinkingDelta: "",
      contentDelta: "",
      thinkingAccumulated: "",
      contentAccumulated: "",
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
  options: Record<string, unknown>, // LLM请求选项（model/url/key/thinking等）
  llmAdapter: MiddlewareContext["adapters"]["llmAdapter"],
  messages: unknown[],
  tools: ToolFunction[],
): AsyncGenerator<StagedChunk> {
  // 打印入参信息
  console.log("\n=== Chat Request ===");
  console.log("Messages:", JSON.stringify(messages, null, 2));

  const response = await llmAdapter.chat(messages, tools, options);

  // 通过 MessageAdapter 提取内容和思考
  const { messageAdapter } = ctx.adapters;
  const content = messageAdapter.content(response);
  const thinking = messageAdapter.thinking?.(response);

  const chunk: StagedChunk = {
    type: "staged",
    content,
    thinking,
    raw: response,
  };
  yield chunk;
}
