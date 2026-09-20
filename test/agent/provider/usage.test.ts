import { describe, expect, it } from 'vitest'
import { extractModelUsage } from '@/agent/provider/usage.js'

describe('provider usage normalization', () => {
  it('keeps absent fields unknown and derives OpenAI totals', () => {
    expect(
      extractModelUsage('openai-chat-completions', {
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }),
    ).toMatchObject({ inputTokens: 12, outputTokens: 5, totalTokens: 17, cacheReadTokens: 3 })
    expect(extractModelUsage('openai-chat-completions', { usage: { prompt_tokens: 0 } })).toEqual({
      inputTokens: 0,
    })
  })

  it('reads provider-specific stream/final response fields', () => {
    expect(
      extractModelUsage('anthropic-messages', {
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      }),
    ).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 17,
    })
    expect(extractModelUsage('ollama-chat', { prompt_eval_count: 8, eval_count: 3 })).toMatchObject(
      { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    )
  })

  it('merges usage-only tail frames without losing earlier counters', () => {
    const first = extractModelUsage('openai-chat-completions', { usage: { prompt_tokens: 9 } })
    expect(
      extractModelUsage(
        'openai-chat-completions',
        { usage: { completion_tokens: 2, total_tokens: 11 } },
        first,
      ),
    ).toMatchObject({ inputTokens: 9, outputTokens: 2, totalTokens: 11 })
  })
})
