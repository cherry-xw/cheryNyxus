import type {
  MiddlewareContext,
  MiddlewareChunk,
  StreamChunk,
  RuntimeConfig,
} from "@/core/middleware/types";
import type { SenseFunction, SenseCallData } from "@/core/sense/adapter";
import type { LLMOptions } from "@/core/llm/adapter";
import { logger } from "@/utils/logger/index.js";
import type { LLMResponse, LLMAttachment } from "@/core/message/adapter";
import { readMediaAsset, understandMediaReference, mediaKindForMime } from "@/service/media/index.js";

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
  // P5b：enrichMediaInputs 改为双轨——脑 input.image=true 时走多模态（marker 移除 + 临时 attachments），
  // 否则保留现有文本转写路径（marker 文本拼接）。attachments 不进 LLMResponse/DB，provider 调用后丢弃。
  const enriched = await enrichMediaInputs(ctx, ctx.soul.messages || []);
  const messages = messageAdapter.buildMessages(enriched.history, enriched.attachments);

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
    chatId: ctx.soul.chatId,
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

/**
 * 上传资产在用户文本中以 [[media:filename]] 标记传递；不改写持久化原文。
 * P5b 双轨：
 *   - 脑 capabilities.input.image=true + 至少一个 marker → 走多模态：readMediaAsset 同步读 base64，
 *     从 last.content 移除 marker，临时 attachments 数组返给 buildMessages（不进 DB）。
 *   - 否则保留旧行为：调媒体网关 understandMediaReference → 把理解文本追加到 last.content。
 * 视频/音频（kind==='video'/'audio'）脑无原生支持时仍走文本转写；脑支持时当前实现忽略（仅 image）。
 */
async function enrichMediaInputs(
  ctx: MiddlewareContext,
  history: LLMResponse[],
): Promise<{ history: LLMResponse[]; attachments?: LLMAttachment[] }> {
  const brain = ctx.runtime?.brain;
  if (!brain) return { history };
  const last = history[history.length - 1];
  if (!last || last.role !== "user") return { history };
  const matches = [...last.content.matchAll(/\[\[media:([a-f0-9-]+\.[a-z0-9]+)\]\]/gi)];
  if (!matches.length) return { history };

  // 脑支持 image 原生视觉 → 多模态旁路
  if (brain.capabilities?.input?.image === true) {
    const attachments: LLMAttachment[] = [];
    let cleanedContent = last.content;
    for (const match of matches) {
      const filename = match[1]!;
      const asset = await readMediaAsset(filename);
      if (!asset) continue;
      const kind = mediaKindForMime(asset.mimeType);
      // 仅 image 走原生视觉；其他 kind 暂不处理（脑未声明能力，跳过以保留文本转写兜底）
      if (kind !== "image") continue;
      attachments.push({ mimeType: asset.mimeType, data: asset.data });
      cleanedContent = cleanedContent.replace(match[0], "").trim();
    }
    if (attachments.length === 0) return { history };
    return {
      history: [...history.slice(0, -1), { ...last, content: cleanedContent }],
      attachments,
    };
  }

  // 旧路径：marker 文本转写
  const additions: string[] = [];
  for (const match of matches) {
    try {
      const understood = await understandMediaReference(match[1]!);
      if (!brain.capabilities?.input?.[understood.kind]) {
        additions.push(`[${understood.kind} 附件未发送：当前模型未标记该输入能力]`);
      } else {
        additions.push(`[${understood.kind} 附件理解结果]\n${understood.text}`);
      }
    } catch (error) {
      additions.push(`[媒体附件处理失败: ${(error as Error).message}]`);
    }
  }
  return {
    history: [...history.slice(0, -1), { ...last, content: `${last.content}\n\n${additions.join("\n\n")}` }],
  };
}
