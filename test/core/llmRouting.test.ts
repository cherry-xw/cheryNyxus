import { describe, expect, it } from 'vitest'
import {
  LlmProtocol,
  findLlmProviderDefinition,
  resolveLlmProviderDefaultUrl,
} from '@chery/protocol'
import { resolveBrainAdapterKey, resolveBrainProtocol } from '@/core/llm/routing.js'

describe('LLM routing', () => {
  it('旧配置继续以 provider 作为 adapter key', () => {
    expect(resolveBrainProtocol({ provider: 'deepseek' })).toBe(LlmProtocol.OPENAI_CHAT_COMPLETIONS)
    expect(resolveBrainAdapterKey({ provider: 'deepseek' })).toBe('deepseek')
  })

  it('新配置按 protocol 选择 adapter，provider 只表示服务入口', () => {
    const brain = {
      provider: 'newapi',
      protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS,
    }
    expect(resolveBrainProtocol(brain)).toBe(LlmProtocol.OPENAI_CHAT_COMPLETIONS)
    expect(resolveBrainAdapterKey(brain)).toBe(LlmProtocol.OPENAI_CHAT_COMPLETIONS)
  })

  it('DeepSeek 一个服务入口提供三种协议，并为 Anthropic 使用专用 base URL', () => {
    expect(findLlmProviderDefinition('deepseek')?.protocols).toEqual([
      LlmProtocol.OPENAI_CHAT_COMPLETIONS,
      LlmProtocol.OPENAI_RESPONSES,
      LlmProtocol.ANTHROPIC_MESSAGES,
    ])
    expect(resolveLlmProviderDefaultUrl('deepseek', LlmProtocol.OPENAI_RESPONSES)).toBe(
      'https://api.deepseek.com',
    )
    expect(resolveLlmProviderDefaultUrl('deepseek', LlmProtocol.ANTHROPIC_MESSAGES)).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })
})
