import type { InputTokenPreflight, LLMOptions } from '@/core/llm/adapter.js'
import { ClassifiedError } from '@/utils/error.js'

/** 只核算即将发送的请求，不运行生成，不把二进制字节换算为收费 token。 */
export async function preflightModelInput(body: Record<string, unknown>, options: LLMOptions | undefined, protocol: string): Promise<void> {
  if (!options?.inputPreflight) return
  options.signal?.throwIfAborted()
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 32 * 1024 * 1024) throw new ClassifiedError({
    message: '序列化请求超过 32 MiB', userMessage: '本次请求内容过大，请减少文件内容输入。', category: 'validation', source: 'chat',
  })
  const text = JSON.stringify(body, (key, value) => {
    if (['file_data', 'encrypted_content'].includes(key) || key === 'data' && typeof value === 'string' || typeof value === 'string' && value.startsWith('data:')) return '[binary omitted]'
    return value
  })
  const result: InputTokenPreflight = {
    tokenSource: 'conservative-local-estimate', officialPreflight: 'unsupported',
    estimatedTextTokens: Buffer.byteLength(text, 'utf8'), mediaTokens: null,
  }
  const suffix = protocol === 'anthropic' ? '/messages' : protocol === 'openai-responses' ? '/responses' : undefined
  if (suffix && options.url && options.key) {
    const base = options.url.replace(/\/+$/, '')
    const endpoint = options.fullUrl ? base : base + suffix
    if (endpoint.endsWith(suffix)) {
      result.officialPreflight = 'unavailable'
      try {
        const url = new URL(endpoint + (protocol === 'anthropic' ? '/count_tokens' : '/input_tokens'))
        const keys = protocol === 'anthropic' ? ['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking']
          : ['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'previous_response_id', 'conversation', 'reasoning', 'text', 'truncation']
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000)
        const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', ...(protocol === 'anthropic'
            ? { 'x-api-key': options.key, 'anthropic-version': '2023-06-01' }
            : { authorization: `Bearer ${options.key}` }) },
          body: JSON.stringify(Object.fromEntries(keys.filter(key => body[key] !== undefined).map(key => [key, body[key]]))),
        })
        if (!response.ok) { await response.body?.cancel(); throw new Error('unavailable') }
        // 响应只应含计数；不无限读取兼容端点返回的任意页面。
        const reader = response.body?.getReader()
        if (!reader) throw new Error('empty')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 8192) throw new Error('too_large')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => undefined) }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input_tokens?: unknown }
        if (!Number.isSafeInteger(value.input_tokens) || Number(value.input_tokens) < 0) throw new Error('invalid_count')
        result.inputTokens = Number(value.input_tokens)
        result.tokenSource = 'official-preflight'
        result.officialPreflight = 'succeeded'
      } catch { options.signal?.throwIfAborted() }
    }
  }
  options.inputPreflight.report(result)
  const tokens = result.inputTokens ?? result.estimatedTextTokens
  if (options.inputPreflight.contextLimit && tokens > options.inputPreflight.contextLimit) throw new ClassifiedError({
    message: '模型输入用量超过上下文上限', category: 'validation', source: 'chat',
    userMessage: result.inputTokens !== undefined ? '官方预检显示本次输入超过模型上下文上限，请减少文件或历史内容。'
      : '本地保守文字估算超过模型上下文上限，请减少内容。媒体 token 未知，此估算不是收费量。',
  })
}
