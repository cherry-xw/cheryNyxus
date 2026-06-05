import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
} from "@/core/middleware/types";
import type { ToolFunction } from "@/core/tool/adapter";

/**
 * Chat Middleware
 * 职责：API 调用、流式输出
 * yield StreamChunk（包含 toolDelta）
 * tool_trigger 逻辑交给 checkpoint 中间件处理
 */
export async function* chatMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  const { llmAdapter, messageAdapter, toolAdapter } = ctx.adapters;

  // 从 ctx.session.messages 构建 provider 格式消息
  const messages = messageAdapter.buildMessages(ctx.session.messages || []);

  // 使用预构建的 tools（builder 层一次性构建）
  const tools = ctx.session.builtTools;

  // 构建请求选项
  const options = {
    model: ctx.aiServer.model,
    url: ctx.aiServer.url,
    key: ctx.aiServer.key,
    ...(ctx.aiServer.thinking && { thinking: true }),
  };

  if (ctx.global.stream) {
    // 流式调用
    yield* handleStream(
      ctx,
      options,
      llmAdapter,
      messageAdapter,
      toolAdapter,
      messages,
      tools,
    );
  } else {
    // 非流式调用
    yield* handleNonStream(
      ctx,
      options,
      llmAdapter,
      messageAdapter,
      toolAdapter,
      messages,
      tools,
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
  toolAdapter: MiddlewareContext["adapters"]["toolAdapter"],
  messages: unknown[],
  tools: ToolFunction[],
): AsyncGenerator<StreamChunk> {
  const streamIterator = await llmAdapter.chatStream(messages, tools, options);

  for await (const rawChunk of streamIterator) {
    // 提取增量
    const thinkingDelta =
      messageAdapter.extractStreamThinking?.(rawChunk) || "";
    const contentDelta = messageAdapter.extractStreamDelta?.(rawChunk) || "";

    // 提取 tool call 增量
    const toolDelta = toolAdapter.extractToolCallDeltas(rawChunk);

    // yield stream chunk（包含 toolDelta）
    if (thinkingDelta || contentDelta || toolDelta.length > 0) {
      yield {
        type: "stream",
        thinkingDelta,
        contentDelta,
        toolDelta: toolDelta.length > 0 ? toolDelta : undefined,
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
  toolAdapter: MiddlewareContext["adapters"]["toolAdapter"],
  messages: unknown[],
  tools: ToolFunction[],
): AsyncGenerator<StreamChunk> {
  const response = await llmAdapter.chat(messages, tools, options);

  // 提取内容和思考
  const content = messageAdapter.content(response);
  const thinking = messageAdapter.thinking?.(response);

  // 提取 tool calls（非流式为完整数据）
  const toolDelta = toolAdapter.toolCalls(response);

  // yield stream chunk（包含 toolDelta）
  if (content || thinking || toolDelta.length > 0) {
    yield {
      type: "stream",
      thinkingDelta: thinking || "",
      contentDelta: content || "",
      toolDelta: toolDelta.length > 0 ? toolDelta : undefined,
    };
  }
}

export default chatMiddleware;
