import type { LLMOptions } from "@/core/llm/adapter";
import { throwUserFacing } from "@/utils/error.js";

/**
 * fetch 基座：供新 provider（bigmodel 及未来 anthropic/minimax/aliyun）用原生 fetch 替代第三方 SDK。
 * Node ≥20 自带 fetch / ReadableStream / TextDecoder / AbortController，无需 polyfill。
 *
 * abort 约定：不靠上层下传 signal，而靠 async generator 生命周期——
 * 外层 for-await 被 compose.ts 的 generator.throw() 打断时，本 generator 的 finally 自动跑，
 * controller.abort() 切断 HTTP 连接（与现有 openai SDK 路径行为一致）。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md) 「fetch 基座」。
 */

/**
 * 校验 LLM 调用必填项：model/url 必填、key 非空且非 $ENV 占位符。
 * 复用 openai.ts 的错误约定（throwUserFacing，message 避开 retry 关键词 → 不重试直接响应前端）。
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
    throw new Error("provider requires model and url in options");
  }
  const placeholderMatch = key?.match(/^\$([A-Z_][A-Z0-9_]*)$/);
  if (placeholderMatch) {
    const envName = placeholderMatch[1]!;
    throwUserFacing(
      "llm.key.missing",
      `${model} 缺少 key。请在 .env 或环境变量中设置 ${envName} 后重启`,
      { model, url, envName, reason: "placeholder_unresolved" },
    );
  }
  if (!key) {
    throwUserFacing(
      "llm.key.missing",
      `${model} 缺少 key。请在 .chery/config.yaml 的 llm.brain 段检查 key 字段`,
      { model, url, reason: "key_empty" },
    );
  }
  return { model, url, key: key as string };
}

/** url 末尾斜杠归一后拼接 path（如 base + "/chat/completions"）。 */
function joinUrl(base: string, p: string): string {
  return `${base.replace(/\/+$/, "")}${p}`;
}

/** 构造 OpenAI 兼容的 Authorization header（Bearer key）。 */
function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/** 从 !res.ok 响应体提取短摘要（≤200 字符），供错误 message。 */
async function readErrorSnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text.slice(0, 200) || res.statusText;
}

/**
 * 非流式 POST JSON 请求（OpenAI 兼容 /chat/completions）。
 * !res.ok 或网络错误 → throwUserFacing（message 避开 retry 关键词 → 不重试）。
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
    throwUserFacing(
      "llm.fetch.network",
      `请求失败: ${(err as Error).message}`,
      { url, reason: "network_error" },
    );
  }
  if (!res.ok) {
    const snippet = await readErrorSnippet(res);
    throwUserFacing(
      "llm.fetch.http",
      `上游返回 ${res.status}: ${snippet}`,
      { url, status: res.status, reason: "http_error" },
    );
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
    throwUserFacing(
      "llm.fetch.network",
      `请求失败: ${(err as Error).message}`,
      { url, reason: "network_error" },
    );
  }
  if (!res.ok || !res.body) {
    const snippet = await readErrorSnippet(res);
    controller.abort();
    throwUserFacing(
      "llm.fetch.http",
      `上游返回 ${res.status}: ${snippet}`,
      { url, status: res.status, reason: "http_error" },
    );
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
