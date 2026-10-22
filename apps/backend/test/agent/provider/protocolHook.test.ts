import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateProtocolParameters, type HookProtocol } from '@/agent/provider/protocolHook.js'
import { registerFunctionHook } from '@/agent/hooks/functions.js'
import { registerDeepseekAdapter } from '@/agent/provider/deepseek.js'
import { registerBigmodelAdapter } from '@/agent/provider/bigmodel.js'
import { registerOpenAIResponsesAdapter } from '@/agent/provider/openaiResponses.js'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import { registerOpenAIAdapter } from '@/agent/provider/openai.js'
import { registerOllamaAdapter } from '@/agent/provider/ollama.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'

const releases: Array<() => void> = []
afterEach(() => { releases.splice(0).forEach(fn => fn()); vi.unstubAllGlobals() })
const valid: Record<HookProtocol, Record<string, unknown>> = {
  openai: { temperature: 2, top_p: 1, max_tokens: 1, max_completion_tokens: 1, stop: ['x'], reasoning_effort: 'high' },
  'openai-responses': { temperature: 1, top_p: 0.5, max_output_tokens: 10, reasoning: { effort: 'high', summary: 'auto' } },
  deepseek: { temperature: 1, top_p: 0.5, max_tokens: 65536, stop: 'x', thinking: { type: 'enabled' }, reasoning_effort: 'max' },
  bigmodel: { temperature: 1, top_p: 0.01, max_tokens: 131072, stop: ['x'], thinking: { type: 'enabled', clear_thinking: false }, reasoning_effort: 'max' },
  anthropic: { temperature: 1, top_p: 1, top_k: 0, max_tokens: 2048, stop_sequences: ['x'], thinking: { type: 'enabled', budget_tokens: 1024 } },
  ollama: { temperature: 1, top_p: 1, top_k: 0, max_tokens: 10, stop: ['x'], thinking: true },
}
describe('protocol hook parameter boundaries', () => {
  it('accepts current reasoning enum values without obsolete protocol-wide exclusions', () => {
    expect(() => validateProtocolParameters({}, { reasoning_effort: 'max' }, 'openai')).not.toThrow()
    expect(() => validateProtocolParameters({}, { reasoning: { effort: 'max' } }, 'openai-responses')).not.toThrow()
    expect(() => validateProtocolParameters({}, { reasoning_effort: 'low' }, 'deepseek')).not.toThrow()
  })
  for (const protocol of Object.keys(valid) as HookProtocol[]) {
    it(`${protocol}: accepts each supported field and rejects incorrect types`, () => {
      const base = { model: 'fixture', max_tokens: 4096 }
      for (const [key, value] of Object.entries(valid[protocol])) {
        expect(() => validateProtocolParameters(base, { ...base, [key]: value }, protocol)).not.toThrow()
        expect(() => validateProtocolParameters(base, { ...base, [key]: null }, protocol)).toThrow()
      }
      expect(() => validateProtocolParameters(base, { ...base, messages: [] }, protocol)).toThrow()
    })
    it(`${protocol}: rejects other protocols and invalid numeric ranges`, () => {
      for (const field of ['thinking', 'reasoning', 'reasoning_effort', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k', 'stop', 'stop_sequences']) {
        if (!(field in valid[protocol]))
          expect(() => validateProtocolParameters({}, { [field]: 1 }, protocol)).toThrow()
      }
      for (const field of ['temperature', 'top_p', 'top_k', 'max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
        if (field in valid[protocol]) {
          for (const value of [-1, NaN, Infinity])
            expect(() => validateProtocolParameters({}, { [field]: value }, protocol)).toThrow()
        }
      }
    })
  }
  it('validates object enums, unknown keys, stop limits and Anthropic budget', () => {
    for (const [protocol, body] of [
      ['deepseek', { thinking: { type: 'oops' } }],
      ['bigmodel', { thinking: { type: 'enabled', clear_thinking: 'yes' } }],
      ['openai-responses', { reasoning: { effort: 'high', unknown: true } }],
      ['openai', { reasoning_effort: 'unlimited' }],
      ['openai', { stop: ['1','2','3','4','5'] }],
      ['anthropic', { max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 1024 } }],
    ] as const) expect(() => validateProtocolParameters({}, body, protocol)).toThrow()
  })
  const adapters = [
    ['deepseek', registerDeepseekAdapter], ['bigmodel', registerBigmodelAdapter],
    ['openai-responses', registerOpenAIResponsesAdapter], ['anthropic', registerAnthropicAdapter],
    ['openai', registerOpenAIAdapter], ['ollama', registerOllamaAdapter],
  ] as const
  for (const [name, register] of adapters) for (const stream of [false, true]) {
    it(`${name}: rejects unsupported fields before network, stream=${stream}`, async () => {
      register()
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      releases.push(registerFunctionHook('policy', 0, [], new AbortController().signal, {
        event: 'PreLLMRequest', handler: payload => ({ body: { ...payload.body,
          ...(name === 'anthropic' ? { stop: ['x'] } : { stop_sequences: ['x'] }),
        } }),
      }))
      const adapter = getLLMAdapter(name === 'anthropic' ? 'anthropic-messages' : name === 'ollama' ? 'ollama-chat' : name === 'openai' ? 'openai-chat-completions' : name)!
      const options = { model: 'fixture', key: 'synthetic', url: 'http://offline.invalid', fullUrl: true }
      const call = async () => {
        if (stream) {
          const chunks = await adapter.chatStream(name === 'anthropic' ? [{ system: '', messages: [] }] : [], [], options)
          for await (const _chunk of chunks) { /* consume lazy streaming adapters */ }
        } else await adapter.chat([], [], options)
      }
      await expect(call()).rejects.toThrow()
      expect(fetch).not.toHaveBeenCalled()
    })
  }
})
