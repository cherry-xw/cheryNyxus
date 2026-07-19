import type { LLMOptions } from "@/core/llm/adapter";
import {
  throwUserFacing,
  ClassifiedError,
  classifyError,
  type ErrorCategory,
} from "@/utils/error.js";

/**
 * fetch 基座：供新 provider（bigmodel 及未来 anthropic/minimax/aliyun）用原生 fetch 替代第三方 SDK。
 * Node ≥20 自带 fetch / ReadableStream / TextDecoder / AbortController，无需 polyfill。
 *
 * abort 约定：不靠上层下传 signal，而靠 async generator 生命周期——
 * 外层 for-await 被 compose.ts 的 generator.throw() 打断时，本 generator 的 finally 自动跑，
 * controller.abort() 切断 HTTP 连接（与现有 openai SDK 路径行为一致）。
 *
 * 错误约定（[docs/error-conventions.md](../../../docs/error-conventions.md)）：
 * - 终态配置错误（缺 key/model/url）→ throwUserFacing（不重试，前置 tracingId）；
 * - 可重试错误（网络/上游非2xx）→ ClassifiedError（携带 category+userMessage+source=brain），
 *   retry 据 category 判重试，表层出口（streamMapper/compose）取 userMessage 作用户面。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md) 「fetch 基座」。
 */

// ========== 大脑错误的友好映射（fetch 路径与 openai SDK 路径共用） ==========

/** 上游返回非 2xx → 按 status 定 category + 直观文案。返回 ClassifiedError 供调用方 throw。 */
export function brainHttpError(status: number, logMessage: string): ClassifiedError {
  let category: ErrorCategory;
  let userMessage: string;
  if (status === 401 || status === 403) {
    category = "auth";
    userMessage = "大脑的钥匙不对，请在设置里检查 key";
  } else if (status === 429) {
    category = "provider";
    userMessage = "脑子忙不过来了，稍后再试";
  } else if (status >= 500) {
    category = "provider";
    userMessage = "脑子出了点状况，稍后再试";
  } else {
    category = "unknown";
    userMessage = "脑子回话不太对";
  }
  return new ClassifiedError({
    message: `upstream ${status}: ${logMessage}`,
    userMessage,
    category,
    source: "brain",
  });
}

/** 网络/DNS/连接失败 → 可重试，友好"连不上我的脑子了"。 */
export function brainNetworkError(logMessage: string, cause: unknown): ClassifiedError {
  return new ClassifiedError({
    message: `fetch failed: ${logMessage}`,
    userMessage: "连不上我的脑子了",
    category: "network",
    source: "brain",
    cause,
  });
}

/**
 * 把任意 SDK/调用错误映射为大脑 ClassifiedError：
 * - 有 status → 走 brainHttpError（auth/provider/unknown）；
 * - 无 status → classifyError 关键词兜底（network/timeout/validation/...），文案走 friendlyMessage。
 * openai.ts / ollama.ts 捕 SDK 错误后调用，避免裸抛漏到 compose 兜底。
 */
export function classifyBrainError(err: unknown): ClassifiedError {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    const msg = err instanceof Error ? err.message : String(err);
    return brainHttpError(status, msg);
  }
  const category = classifyError(err);
  return new ClassifiedError({
    message: err instanceof Error ? err.message : String(err),
    userMessage: brainFriendly(category),
    category,
    source: "brain",
    cause: err,
  });
}

/**
 * 包裹任意 async iterable：迭代中抛错时映射为大脑 ClassifiedError（连接中断/限流/鉴权等），
 * 避免裸错误漏到 compose 兜底。供 openai/ollama 的 chatStream 复用。
 */
export async function* wrapBrainStream(stream: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  try {
    for await (const chunk of stream) yield chunk;
  } catch (err) {
    throw classifyBrainError(err);
  }
}

/** 大脑侧 friendlyMessage（与 utils/error 的 brain 列一致，单独列出便于就近维护）。 */
function brainFriendly(category: ErrorCategory): string {
  switch (category) {
    case "network":
      return "连不上我的脑子了";
    case "auth":
      return "大脑的钥匙不对，请在设置里检查 key";
    case "timeout":
      return "脑子反应太慢了";
    case "provider":
      return "脑子忙不过来了，稍后再试";
    case "validation":
      return "脑子没听懂这个请求";
    case "unknown":
    default:
      return "脑子出了点小问题";
  }
}

// ========== 必填项校验 ==========

/**
 * 校验 LLM 调用必填项：model/url 必填、key 非空且非 $ENV 占位符。
 * 占位符 $VAR（env 未配置时 replaceEnvVars 原样返回）必须也视为缺失——
 * 不然会作为 token 发出 → 后端 401，错误信息毫无指引。
 */
export function assertChatOptions(options?: LLMOptions): {
  model: string;
  url: string;
  key: string;
} {
  const model = options?.model;
  const url = options?.url;
  const key = options?.key;
  if (!model || !url) {
    throwUserFacing("llm.options.missing", "大脑没配好（缺 model 或地址），请在设置里检查", {
      reason: "missing_model_or_url",
    });
  }
  const placeholderMatch = key?.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (placeholderMatch) {
    const envName = placeholderMatch[1]!;
    throwUserFacing(
      "llm.key.missing",
      `大脑的钥匙没配好（${model}），请在设置里检查`,
      { model, envName, reason: "placeholder_unresolved" },
    );
  }
  if (!key) {
    throwUserFacing(
      "llm.key.missing",
      `大脑的钥匙没配好（${model}），请在设置里检查`,
      { model, reason: "key_empty" },
    );
  }
  return { model, url, key: key as string };
}

// ========== fetch 工具 ==========

/** url 末尾斜杠归一后拼接 path（如 base + "/chat/completions"）。 */
function joinUrl(base: string, p: string): string {
  return `${base.replace(/\/+$/, "")}${p}`;
}

/** 构造 OpenAI 兼容的 Authorization header（Bearer key）。 */
function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/** 从 !res.ok 响应体提取短摘要（≤200 字符），供日志面 message。 */
async function readErrorSnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 200) || res.statusText;
}

/**
 * 非流式 POST JSON 请求（OpenAI 兼容 /chat/completions）。
 * !res.ok 或网络错误 → 抛 ClassifiedError（可重试，retry 据 category 判重试）。
 */
export async function jsonRequest(
  url: string,
  body: unknown,
  key: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(joinUrl(url, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(key) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw brainNetworkError((err as Error).message, err);
  }
  if (!res.ok) {
    const snippet = await readErrorSnippet(res);
    throw brainHttpError(res.status, snippet);
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * 流式 SSE 请求（OpenAI 兼容 /chat/completions，stream:true）：yield 每个 `data:` 事件的解析后 JSON。
 *
 * - 内部自建 AbortController（不暴露给上层）。
 * - getReader() + TextDecoder 跨 TCP chunk 行缓冲，按 \n 切行。
 * - 跳过空行（SSE 事件分隔）与 `:` 开头（SSE 注释 / keep-alive 心跳）。
 * - 剥离 `data:` 前缀；`[DONE]` 主动结束。
 * - finally 必跑 controller.abort() + reader.cancel()：正常结束或 generator.throw() 注入的
 *   abort 都会切断 HTTP 连接（对接现有 abort 机制，避免 socket hang up 堆栈泄漏）。
 *
 * 单行 JSON.parse 失败不致命（跳过）；多段 thinking block 等未来扩展可在调用方处理 chunk 形态。
 */
export async function* streamSSE(
  url: string,
  body: unknown,
  key: string,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const controller = new AbortController();
  let res: Response;
  try {
    res = await fetch(joinUrl(url, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeaders(key),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    controller.abort();
    throw brainNetworkError((err as Error).message, err);
  }
  if (!res.ok || !res.body) {
    const snippet = await readErrorSnippet(res);
    controller.abort();
    throw brainHttpError(res.status, snippet);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = rawLine.replace(/\r$/, "").trim();
        if (line === "") continue; // SSE 事件分隔空行
        if (line.startsWith(":")) continue; // SSE 注释 / keep-alive 心跳
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          controller.abort();
          return;
        }
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // 单行 JSON 解析失败不致命，跳过该事件
        }
      }
    }
  } finally {
    // 正常结束或 generator.throw() 注入的 abort，都切断 HTTP 连接
    controller.abort();
    await reader.cancel().catch(() => {});
  }
}
