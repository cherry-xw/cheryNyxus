import type { LLMOptions } from '@/core/llm/adapter'
import {
  throwUserFacing,
  ClassifiedError,
  classifyError,
  type ErrorCategory,
} from '@/utils/error.js'

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

/** 伪 200（非事件流/JSON 响应，典型如网关对未知路径回退 Web 控制台 SPA）→ 配置类错误：
 *  不重试（validation），文案指引检查 brain 的 url。见 docs/agent/provider.md「流完整性校验」。 */
export function brainInvalidStream(detail: string): ClassifiedError {
  return new ClassifiedError({
    message: `invalid stream: ${detail}`,
    userMessage: `大脑配置可能有误：${detail}，请在设置里检查 brain 的 url`,
    category: 'validation',
    source: 'brain',
  })
}

/** 流正常结束但 0 个有效事件 → 端点/模型服务异常：provider 类可重试，仍空则报前端。 */
export function brainEmptyStream(): ClassifiedError {
  return new ClassifiedError({
    message: 'empty stream: 0 SSE events before close',
    userMessage: '大模型调用失败：响应流为空，请稍后重试或检查 brain 配置',
    category: 'provider',
    source: 'brain',
  })
}

/** 上游返回非 2xx → 按 status 定 category + 直观文案。返回 ClassifiedError 供调用方 throw。 */
export function brainHttpError(status: number, logMessage: string): ClassifiedError {
  let category: ErrorCategory
  let userMessage: string
  if (status === 401 || status === 403) {
    category = 'auth'
    userMessage = '大脑的钥匙不对，请在设置里检查 key'
  } else if (status === 429) {
    category = 'provider'
    userMessage = '脑子忙不过来了，稍后再试'
  } else if (status >= 500) {
    category = 'provider'
    userMessage = '脑子出了点状况，稍后再试'
  } else {
    category = 'unknown'
    userMessage = '脑子回话不太对'
  }
  return new ClassifiedError({
    message: `upstream ${status}: ${logMessage}`,
    userMessage,
    category,
    source: 'brain',
  })
}

/** 网络/DNS/连接失败 → 可重试，友好"连不上我的脑子了"。 */
export function brainNetworkError(logMessage: string, cause: unknown): ClassifiedError {
  return new ClassifiedError({
    message: `fetch failed: ${logMessage}`,
    userMessage: '连不上我的脑子了',
    category: 'network',
    source: 'brain',
    cause,
  })
}

/**
 * 把任意 SDK/调用错误映射为大脑 ClassifiedError：
 * - 有 status → 走 brainHttpError（auth/provider/unknown）；
 * - 无 status → classifyError 关键词兜底（network/timeout/validation/...），文案走 friendlyMessage。
 * openai.ts / ollama.ts 捕 SDK 错误后调用，避免裸抛漏到 compose 兜底。
 */
export function classifyBrainError(err: unknown): ClassifiedError {
  const status = (err as { status?: number })?.status
  if (typeof status === 'number') {
    const msg = err instanceof Error ? err.message : String(err)
    return brainHttpError(status, msg)
  }
  const category = classifyError(err)
  return new ClassifiedError({
    message: err instanceof Error ? err.message : String(err),
    userMessage: brainFriendly(category),
    category,
    source: 'brain',
    cause: err,
  })
}

/**
 * 包裹任意 async iterable：迭代中抛错时映射为大脑 ClassifiedError（连接中断/限流/鉴权等），
 * 避免裸错误漏到 compose 兜底。供 openai/ollama 的 chatStream 复用。
 */
export async function* wrapBrainStream(stream: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  try {
    for await (const chunk of stream) yield chunk
  } catch (err) {
    throw classifyBrainError(err)
  }
}

/** 大脑侧 friendlyMessage（与 utils/error 的 brain 列一致，单独列出便于就近维护）。 */
function brainFriendly(category: ErrorCategory): string {
  switch (category) {
    case 'network':
      return '连不上我的脑子了'
    case 'auth':
      return '大脑的钥匙不对，请在设置里检查 key'
    case 'timeout':
      return '脑子反应太慢了'
    case 'provider':
      return '脑子忙不过来了，稍后再试'
    case 'validation':
      return '脑子没听懂这个请求'
    case 'unknown':
    default:
      return '脑子出了点小问题'
  }
}

// ========== 必填项校验 ==========

/**
 * 校验 LLM 调用必填项：model/url 必填、key 非空且非 $ENV 占位符。
 * 占位符 $VAR（env 未配置时 replaceEnvVars 原样返回）必须也视为缺失——
 * 不然会作为 token 发出 → 后端 401，错误信息毫无指引。
 */
export function assertChatOptions(options?: LLMOptions): {
  model: string
  url: string
  key: string
} {
  const model = options?.model
  const url = options?.url
  const key = options?.key
  if (!model || !url) {
    throwUserFacing('llm.options.missing', '大脑没配好（缺 model 或地址），请在设置里检查', {
      reason: 'missing_model_or_url',
    })
  }
  const placeholderMatch = key?.match(/^\$([A-Z_][A-Z0-9_]*)$/)
  if (placeholderMatch) {
    const envName = placeholderMatch[1]!
    throwUserFacing('llm.key.missing', `大脑的钥匙没配好（${model}），请在设置里检查`, {
      model,
      envName,
      reason: 'placeholder_unresolved',
    })
  }
  if (!key) {
    throwUserFacing('llm.key.missing', `大脑的钥匙没配好（${model}），请在设置里检查`, {
      model,
      reason: 'key_empty',
    })
  }
  return { model, url, key: key as string }
}

// ========== fetch 工具 ==========

/** scheme 后是否还有路径段（https://gw:1 无 → false；https://gw:1/v1 有 → true）。 */
function hasUrlPath(base: string): boolean {
  return base.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').includes('/')
}

/**
 * URL 自动补全（[docs/agent/provider.md「URL 解析与自动补全」](../../../docs/agent/provider.md)）：
 * - fullUrl=true：URL 原样使用，不做任何拼接（请求地址须含版本段与端点）
 * - base 无路径：补 versionPath + endpoint（如 /v1/chat/completions）——兼容早期自动补全时代的旧配置
 * - base 已有路径（/v1、自定义网关前缀等）：只拼 endpoint（尊重用户输入）
 * endpoint 传空串时仅做版本段补全（openai SDK baseURL 场景：SDK 自拼 endpoint）。
 */
export function buildEndpointUrl(
  url: string,
  opts: { fullUrl?: boolean; versionPath?: string; endpoint: string },
): string {
  const base = url.replace(/\/+$/, '')
  const { fullUrl, versionPath = '/v1', endpoint } = opts
  if (fullUrl) return base
  if (hasUrlPath(base)) return `${base}${endpoint}`
  return `${base}${versionPath}${endpoint}`
}

/** 构造 OpenAI 兼容的 Authorization header（Bearer key）。 */
function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` }
}

/** 从 !res.ok 响应体提取短摘要（≤200 字符），供日志面 message。 */
export async function readErrorSnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  return text.slice(0, 200) || res.statusText
}

/**
 * 非流式 POST JSON 请求（OpenAI 兼容 /chat/completions）。
 * !res.ok 或网络错误 → 抛 ClassifiedError（可重试，retry 据 category 判重试）；
 * 伪 200（content-type 非 JSON / 响应体非法 JSON，如网关 SPA 回退）→ validation 配置错误。
 */
export async function jsonRequest(
  url: string,
  body: unknown,
  key: string,
  signal?: AbortSignal,
  opts?: { fullUrl?: boolean },
): Promise<Record<string, unknown>> {
  const endpoint = buildEndpointUrl(url, { fullUrl: opts?.fullUrl, endpoint: '/chat/completions' })
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw brainNetworkError((err as Error).message, err)
  }
  if (!res.ok) {
    const snippet = await readErrorSnippet(res)
    throw brainHttpError(res.status, snippet)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    throw brainInvalidStream(`端点返回的不是 JSON 响应（content-type: ${contentType || '未知'}；url 可能缺 /v1 前缀）`)
  }
  try {
    return (await res.json()) as Record<string, unknown>
  } catch (err) {
    throw brainInvalidStream(`响应体不是合法 JSON（${err instanceof Error ? err.message : String(err)}；url 可能缺 /v1 前缀）`)
  }
}

/**
 * 流式 SSE 请求（OpenAI 兼容 /chat/completions，stream:true）：yield 每个 `data:` 事件的解析后 JSON。
 *
 * - 内部自建 AbortController（不暴露给上层）。
 * - getReader() + TextDecoder 跨 TCP chunk 行缓冲，按 \n 切行。
 * - 跳过空行（SSE 事件分隔）与 `:` 开头（SSE 注释 / keep-alive 心跳）。
 * - 剥离 `data:` 前缀；`[DONE]` 主动结束。
 * - 流完整性校验（docs/agent/provider.md「流完整性校验」）：伪 200（content-type 非
 *   event-stream，如网关 SPA 回退）→ validation；流结束 0 有效事件 → provider（空流）。
 * - finally 必跑 controller.abort() + reader.cancel()：正常结束或 generator.throw() 注入的
 *   abort 都会切断 HTTP 连接（对接现有 abort 机制，避免 socket hang up 堆栈泄漏）。
 *
 * 单行 JSON.parse 失败不致命（跳过）；多段 thinking block 等未来扩展可在调用方处理 chunk 形态。
 */
export async function* streamSSE(
  url: string,
  body: unknown,
  key: string,
  signal?: AbortSignal,
  opts?: { fullUrl?: boolean },
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const endpoint = buildEndpointUrl(url, { fullUrl: opts?.fullUrl, endpoint: '/chat/completions' })
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abortFromParent, { once: true })
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(key),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    controller.abort()
    signal?.removeEventListener('abort', abortFromParent)
    throw brainNetworkError((err as Error).message, err)
  }
  if (!res.ok || !res.body) {
    const snippet = await readErrorSnippet(res)
    controller.abort()
    signal?.removeEventListener('abort', abortFromParent)
    throw brainHttpError(res.status, snippet)
  }
  // 伪 200 拦截：SSE 请求收到非事件流（典型如网关对未知路径回退 Web 控制台 HTML）
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream')) {
    controller.abort()
    signal?.removeEventListener('abort', abortFromParent)
    throw brainInvalidStream(`端点返回的不是事件流（content-type: ${contentType || '未知'}；url 可能缺 /v1 前缀）`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let yielded = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const line = rawLine.replace(/\r$/, '').trim()
        if (line === '') continue // SSE 事件分隔空行
        if (line.startsWith(':')) continue // SSE 注释 / keep-alive 心跳
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          controller.abort()
          if (yielded === 0) throw brainEmptyStream()
          return
        }
        try {
          yield JSON.parse(payload) as Record<string, unknown>
          yielded++
        } catch {
          // 单行 JSON 解析失败不致命，跳过该事件
        }
      }
    }
    // 流正常关闭但 0 有效事件（连 [DONE] 都未收到）→ 空流
    if (yielded === 0) throw brainEmptyStream()
  } finally {
    // 正常结束或 generator.throw() 注入的 abort，都切断 HTTP 连接
    controller.abort()
    await reader.cancel().catch(() => {})
    signal?.removeEventListener('abort', abortFromParent)
  }
}
