import { modelBudget, ModelInputNeedsCompaction } from './modelBudget.js'
import type { InputTokenPreflight, LLMOptions } from '@/core/llm/adapter.js'
import { ClassifiedError } from '@/utils/error.js'
import { ErrorId } from '@chery/protocol'

/** 只核算即将发送的请求，不运行生成，不把二进制字节换算为收费 token。 */
export async function preflightModelInput(body: Record<string, unknown>, options: LLMOptions | undefined, protocol: string): Promise<void> {
  if (!options?.inputPreflight) return
  options.signal?.throwIfAborted()
  const budget = modelBudget(body, options.inputPreflight.contextLimit, options.inputPreflight.safetyMargin)
  if (budget.payloadBytes > 32 * 1024 * 1024) throw new ClassifiedError({
    errorId: ErrorId.REQUEST_INPUT_TOO_LARGE, message: '序列化请求超过 32 MiB', userMessage: '本次请求内容过大，请减少文件内容输入。', category: 'validation', source: 'chat',
  })
  const result: InputTokenPreflight = {
    projectionId: budget.projectionId, payloadBytes: budget.payloadBytes,
    contextLimit: options.inputPreflight.contextLimit, preparedAt: Date.now(),
    outputReserve: budget.outputReserve, safetyMargin: budget.safetyMargin, effectiveCeiling: budget.effectiveCeiling,
    tokenSource: 'conservative-local-estimate', officialPreflight: 'unsupported',
    estimatedTextTokens: budget.estimatedTextTokens, mediaTokens: null,
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
  options.sourceCall?.budget?.(result)
  // 本地字节上界仅供诊断，不是 tokenizer 计数；不能据此宣称模型上下文超限。
  // 请求大小保护由前面的字节预算负责，容量调度由 Backend 压缩流程负责。
  const measured = result.inputTokens ?? result.estimatedTextTokens
  const ceiling = budget.effectiveCeiling
  const trigger = options.inputPreflight.trigger
  const threshold = ceiling === undefined ? undefined : Math.min(ceiling, trigger ? trigger.unit === 'percent' ? options.inputPreflight.contextLimit! * trigger.value : trigger.value : ceiling)
  if (options.inputPreflight.compactIfNeeded && (options.inputPreflight.forcePreparation || threshold !== undefined && measured >= threshold)) throw new ModelInputNeedsCompaction()
  if (options.inputPreflight.afterCompaction && ceiling !== undefined && measured >= ceiling) throw new ClassifiedError({ errorId: ErrorId.REQUEST_INPUT_TOO_LARGE, message: 'Prepared summary still exceeds input budget', userMessage: '历史整理后仍无法放入当前模型的输入预算，原始历史已保留。请减少本次输入或固定提示词与工具。', category: 'validation', source: 'chat' })
  const tokens = result.inputTokens
  if (options.inputPreflight.contextLimit && tokens !== undefined && tokens > (ceiling ?? options.inputPreflight.contextLimit)) throw new ClassifiedError({
    errorId: ErrorId.REQUEST_INPUT_TOO_LARGE, message: '模型输入用量超过上下文上限', category: 'validation', source: 'chat',
    userMessage: '官方预检显示本次输入超过模型上下文上限，请减少文件或历史内容。',
  })
  options.inputPreflight.accepted?.()
}
