import type { ModelUsage } from '@/core/llm/usage.js'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Only protocol-defined fields; absent counters never become known zeroes. */
export function extractModelUsage(
  protocol: string,
  raw: unknown,
  previous: ModelUsage = {},
): ModelUsage {
  const record = object(raw)
  const response = object(record.response)
  const message = object(record.message)
  const usage = object(record.usage ?? response.usage ?? message.usage)
  const result = { ...previous }
  const set = (key: keyof ModelUsage, value: unknown) => {
    const n = count(value)
    if (n !== undefined) result[key] = n
  }
  if (protocol === 'mock') return result
  if (protocol === 'ollama' || protocol === 'ollama-chat') {
    set('inputTokens', record.prompt_eval_count)
    set('outputTokens', record.eval_count)
  } else if (protocol === 'anthropic' || protocol === 'anthropic-messages') {
    set('inputTokens', usage.input_tokens)
    set('outputTokens', usage.output_tokens)
    set('cacheReadTokens', usage.cache_read_input_tokens)
    set('cacheWriteTokens', usage.cache_creation_input_tokens)
  } else if (protocol === 'openai-responses') {
    set('inputTokens', usage.input_tokens)
    set('outputTokens', usage.output_tokens)
    set('totalTokens', usage.total_tokens)
    set('cacheReadTokens', object(usage.input_tokens_details).cached_tokens)
    set('reasoningTokens', object(usage.output_tokens_details).reasoning_tokens)
  } else {
    set('inputTokens', usage.prompt_tokens)
    set('outputTokens', usage.completion_tokens)
    set('totalTokens', usage.total_tokens)
    set(
      'cacheReadTokens',
      usage.prompt_cache_hit_tokens ?? object(usage.prompt_tokens_details).cached_tokens,
    )
    set('reasoningTokens', object(usage.completion_tokens_details).reasoning_tokens)
  }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
    if (protocol === 'anthropic' || protocol === 'anthropic-messages') {
      // Do not claim a complete total when a cache counter has not been reported.
      if (result.cacheReadTokens !== undefined && result.cacheWriteTokens !== undefined)
        result.totalTokens =
          result.inputTokens +
          result.outputTokens +
          result.cacheReadTokens +
          result.cacheWriteTokens
    } else if (count(usage.total_tokens) === undefined) {
      result.totalTokens = result.inputTokens + result.outputTokens
    }
  }
  return result
}
