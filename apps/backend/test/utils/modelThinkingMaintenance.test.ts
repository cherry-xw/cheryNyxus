import { cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadModelCatalog, resetModelCatalogCache, resolveModelCatalog,
  resolveCatalogThinkingParams, resolveCatalogThinkingSelection,
  resolveEffectiveBrainCapabilities,
  catalogToolCallsAllowed,
} from '@/utils/modelCatalog.js'
import { registerOpenAIAdapter } from '@/agent/provider/openai.js'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import { registerOpenAIResponsesAdapter } from '@/agent/provider/openaiResponses.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'

const template = resolve('apps/backend/.chery.template/model-catalog.yaml')
beforeEach(() => {
  cpSync(template, join(process.env.CHERY_DIR!, '.chery', 'model-catalog.yaml'))
  resetModelCatalogCache()
})

describe('official model thinking maintenance', () => {
  it.each([
    ['MiniMax-M3.1-Flash-Preview', 'minimax-m3.1-flash-preview'],
    ['relay/MINIMAX-M3.1-FLASH-PREVIEW-20261017', 'minimax-m3.1-flash-preview'],
    ['relay:minimax_m3_1_flash_preview', 'minimax-m3.1-flash-preview'],
    ['MiniMax-M3', 'minimax-m3'],
    ['namespace/GPT-6.1-SOL-2026-10-17', 'openai-gpt-6.1-sol'],
    ['gpt-6-astra', 'openai-gpt-6-astra'],
    ['gpt-6-sol', 'openai-gpt-6'],
    ['glm-5.3-flashx', 'zhipu-glm-5.3-flash'],
    ['step-3.7-flash', 'step-3.7'],
    ['qwen3-vl-plus', 'alibaba-qwen3-vl-hybrid'],
    ['Qwen/Qwen3-VL-235B-A22B-Thinking', 'alibaba-qwen3-vl-thinking'],
    ['gemini-3.1-pro-preview', 'google-gemini-3.1-pro'],
    ['mimo-v2.6-pro-ultraspeed', 'xiaomi-mimo-v2-thinking'],
  ])('recognizes %s without borrowing a generation', (model, id) => {
    expect(resolveModelCatalog({ model }).id).toBe(id)
  })

  it.each(['minimax-m3.2-flash-preview', 'gpt-6.2-sol', 'deepseek-v4.1', 'glm-5.4', 'mimo-v2.9-pro'])('keeps unknown generation %s unknown', model => {
    expect(resolveModelCatalog({ model }).matched).toBe(false)
    expect(resolveCatalogThinkingSelection({ model, protocol: 'openai-chat-completions', display: 'off' }).params).toBeUndefined()
  })

  it.each(['openai-chat-completions', 'openai-responses', 'anthropic-messages'] as const)('M3.1 off remains a conflict on %s without silently choosing a paid effort', protocol => {
    const result = resolveCatalogThinkingSelection({ model: 'minimax-m3.1-flash-preview', provider: 'custom', protocol, display: 'off' })
    expect(result).toMatchObject({ requested: 'off', effective: 'off', cannotDisable: true })
    expect(result.params).toBeUndefined()
    for (const display of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(resolveCatalogThinkingSelection({ model: 'minimax-m3.1-flash-preview', protocol, display }).effective).toBe(display)
      expect(resolveCatalogThinkingParams({ model: 'minimax-m3.1-flash-preview', protocol, display })).toBeDefined()
    }
  })

  it('M3 remains switchable while M2.7 is always thinking, with correct context', () => {
    expect(resolveCatalogThinkingSelection({ model: 'MiniMax-M3', protocol: 'openai-chat-completions', display: 'off' })).toMatchObject({ effective: 'off', cannotDisable: false, params: { thinking: { type: 'disabled' } } })
    expect(resolveCatalogThinkingSelection({ model: 'MiniMax-M2.7', protocol: 'openai-chat-completions', display: 'off' })).toMatchObject({ effective: 'off', cannotDisable: true })
    expect(resolveModelCatalog({ model: 'MiniMax-M2.7' }).facts?.contextWindow).toBe(204800)
  })

  it('Claude adaptive-only activation is not forced thinking and has xhigh', () => {
    const model = 'claude-opus-4.7', protocol = 'anthropic-messages'
    expect(resolveModelCatalog({ model, protocol }).thinkingLevels).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(resolveCatalogThinkingSelection({ model, protocol, display: 'off' })).toMatchObject({ cannotDisable: false, params: { thinking: { type: 'disabled' } } })
  })

  it('native output and input facts are distinct from tool generation and user overrides', () => {
    for (const model of ['gpt-5.5', 'gpt-5.6', 'gpt-6-sol', 'gpt-6.1-sol']) {
      expect(resolveEffectiveBrainCapabilities({ model, protocol: 'openai-responses' }).output.image.state).toBe('unsupported')
    }
    expect(resolveEffectiveBrainCapabilities({ model: 'step-3.5-flash-2603', protocol: 'openai-chat-completions' }).input.image.state).toBe('unsupported')
    expect(resolveEffectiveBrainCapabilities({ model: 'MiniMax-M3.1-Flash-Preview', protocol: 'openai-chat-completions' }).imageInput.maxBytes).toBe(10000000)
    expect(resolveEffectiveBrainCapabilities({ model: 'MiniMax-M3.1-Flash-Preview', userCapabilities: { input: { image: 'unknown' } } }).input.image).toEqual({ state: 'unknown', source: 'user' })
    expect(resolveEffectiveBrainCapabilities({ model: 'gpt-6.1-sol', protocol: 'openai-chat-completions' }).toolCall.enabled).toBe(false)
  })

  it('every declared thinking level resolves, without leaking protocol-specific controls', () => {
    for (const rule of loadModelCatalog().models) {
      for (const [protocol, wire] of Object.entries(rule.wire ?? {})) {
        for (const { params } of wire.thinking ?? []) {
          if (protocol === 'openai-chat-completions') { expect(params).not.toHaveProperty('reasoning'); expect(params).not.toHaveProperty('output_config') }
          if (protocol === 'openai-responses') { expect(params).not.toHaveProperty('thinking'); expect(params).not.toHaveProperty('reasoning_effort'); expect(params).not.toHaveProperty('output_config') }
          if (protocol === 'anthropic-messages') { expect(params).not.toHaveProperty('reasoning'); expect(params).not.toHaveProperty('reasoning_effort') }
        }
      }
    }
  })

  it.each([false, true])('serializes the actual M3.1 transport payload with stream=%s, no network', async stream => {
    registerOpenAIAdapter()
    const transport = vi.fn(async () => stream
      ? new Response('data: {"choices":[{"delta":{"content":"offline"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'offline' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', transport)
    try {
      const model = 'minimax-m3.1-flash-preview'
      const selection = resolveCatalogThinkingSelection({ model, protocol: 'openai-chat-completions', display: 'low' })
      const options = { model, url: 'https://offline.invalid/v1', key: 'synthetic', continuous: true, skipHooks: true, thinking: selection.effective, thinkingParams: selection.params }
      const adapter = getLLMAdapter('openai')!
      if (stream) for await (const _chunk of await adapter.chatStream([{ role: 'user', content: 'offline' }], [], options)) { /* consume */ }
      else await adapter.chat([{ role: 'user', content: 'offline' }], [], options)
      expect(transport).toHaveBeenCalledTimes(1)
      const body = JSON.parse((transport.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]![1].body as string)
      expect(body.reasoning_effort).toBe('low')
      for (const name of ['thinking', 'reasoning_split', 'output_config', 'reasoning']) expect(body).not.toHaveProperty(name)
      expect(body.model).toBe(model)
    } finally { vi.unstubAllGlobals() }
  })

  it.each(['gpt-6-sol', 'gpt-6-luna'])('%s permits Chat function calls only with off/none', model => {
    for (const display of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(catalogToolCallsAllowed({ model, protocol: 'openai-chat-completions', display })).toBe(display === 'off')
      expect(catalogToolCallsAllowed({ model, protocol: 'openai-responses', display })).toBe(true)
    }
  })

  it.each(['gpt-6-astra', 'gpt-6.1-sol'])('%s requires Responses for every function-call effort', model => {
    for (const display of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(catalogToolCallsAllowed({ model, protocol: 'openai-chat-completions', display })).toBe(false)
      expect(catalogToolCallsAllowed({ model, protocol: 'openai-responses', display })).toBe(true)
    }
  })

  it.each(['low', 'high', 'max'])('Kimi K3 maps %s independently on all three protocols', display => {
    const model = 'kimi-k3'
    expect(resolveCatalogThinkingParams({ model, protocol: 'openai-chat-completions', display })).toEqual({ reasoning_effort: display })
    expect(resolveCatalogThinkingParams({ model, protocol: 'anthropic-messages', display })).toEqual({ output_config: { effort: display } })
    expect(resolveCatalogThinkingParams({ model, protocol: 'openai-responses', display })).toEqual({ reasoning: { effort: display } })
  })

  it.each(['gpt-6-unknown', 'gemini-2.5-pro-image', 'gemini-3.1-pro-image', 'doubao-seedream-5-0-flash-999999', 'deepseek-reasoner'])('unverified concrete variant %s does not acquire invented wire', model => {
    expect(resolveModelCatalog({ model, protocol: 'openai-chat-completions' }).thinkingLevels).toEqual([])
  })

  it.each([
    ['openai-chat-completions', 'openai', false], ['openai-chat-completions', 'openai', true],
    ['anthropic-messages', 'anthropic', false], ['anthropic-messages', 'anthropic', true],
    ['openai-responses', 'openai-responses', false], ['openai-responses', 'openai-responses', true],
  ] as const)('Kimi serializes %s adapter=%s stream=%s offline', async (protocol, adapterKey, stream) => {
    registerOpenAIAdapter(); registerAnthropicAdapter(); registerOpenAIResponsesAdapter()
    const transport = vi.fn(async () => {
      if (stream) return new Response(protocol === 'anthropic-messages'
        ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"offline","content":[]}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
        : protocol === 'openai-responses'
          ? 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"offline","output":[]}}\n\n'
          : 'data: {"choices":[{"delta":{"content":"offline"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      return new Response(JSON.stringify(protocol === 'anthropic-messages' ? { id: 'offline', content: [{ type: 'text', text: 'offline' }] } : protocol === 'openai-responses' ? { id: 'offline', output: [] } : { choices: [{ message: { content: 'offline' } }] }), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', transport)
    try {
      const model = 'kimi-k3', display = 'low'
      const options = { model, protocol, url: 'https://offline.invalid/v1', key: 'synthetic', continuous: true, skipHooks: true, thinking: display, thinkingParams: resolveCatalogThinkingParams({ model, protocol, display }) }
      const adapter = getLLMAdapter(adapterKey)!
      if (stream) for await (const _chunk of await adapter.chatStream([{ role: 'user', content: 'offline' }], [], options)) { /* consume */ }
      else await adapter.chat([{ role: 'user', content: 'offline' }], [], options)
      expect(transport).toHaveBeenCalledTimes(1)
      const body = JSON.parse((transport.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]![1].body as string)
      if (protocol === 'openai-chat-completions') { expect(body.reasoning_effort).toBe('low'); expect(body).not.toHaveProperty('reasoning') }
      if (protocol === 'anthropic-messages') { expect(body.output_config).toEqual({ effort: 'low' }); expect(body).not.toHaveProperty('reasoning_effort') }
      if (protocol === 'openai-responses') { expect(body.reasoning).toEqual({ effort: 'low' }); expect(body).not.toHaveProperty('output_config') }
      expect(body).not.toHaveProperty('thinking')
    } finally { vi.unstubAllGlobals() }
  })

  it('withdraws old MiMo and generic family media assertions instead of guessing', () => {
    for (const model of ['mimo-v2-pro', 'mimo-v2-omni', 'qwen3-vl-unverified']) {
      expect(resolveEffectiveBrainCapabilities({ model }).input.image.state).toBe('unknown')
    }
    expect(resolveModelCatalog({ model: 'deepseek-v3.2-speciale' }).facts?.capabilities?.toolCall).toBe(false)
    expect(resolveModelCatalog({ model: 'deepseek-r1-0528' }).facts?.capabilities?.toolCall).toBe(true)
  })
})
