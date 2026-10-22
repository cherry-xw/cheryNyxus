import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatMiddleware } from '@/agent/middleware/chat.js'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import { registerOpenAIResponsesAdapter } from '@/agent/provider/openaiResponses.js'
import { getMessageAdapter } from '@/core/message/adapter.js'
import { getSenseAdapter } from '@/core/sense/adapter.js'
import { listServerToolObservations } from '@/db/serverToolObservations.js'
import { readBrainServiceCapabilities } from '@/service/config/brainCapabilities.js'
import { createServerToolScope } from '@/utils/serverToolScope.js'
import { collectChunks } from '../helpers/chunkAssert.js'
import { createMockContext, createMockRuntime, makeNext, mockLLMAdapter } from '../helpers/fakeContext.js'

const fixture = JSON.parse(readFileSync(
  new URL('../provider/fixtures/server-tools-observed.json', import.meta.url), 'utf8',
))
const cases = [
  { adapter: 'anthropic', protocol: 'anthropic-messages', name: 'web_search_prime', events: fixture.glm },
  { adapter: 'openai-responses', protocol: 'openai-responses', name: 'web_search_call', events: [fixture.gpt] },
] as const

beforeEach(() => {
  registerAnthropicAdapter()
  registerOpenAIResponsesAdapter()
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('离线测试禁止网络请求') }))
})
afterEach(() => vi.unstubAllGlobals())

describe('请求流程中的连接工具观察记录', () => {
  for (const entry of cases) {
    it.each([false, true])(`${entry.protocol} 最终回答失败=%s，保存真实工具名且不建立验证成功`, async failure => {
      const runtime = createMockRuntime({
        brain: { provider: 'newapi', model: 'offline-model', url: 'https://example.invalid/v1', key: randomUUID() },
        adapters: {
          messageAdapter: getMessageAdapter(entry.adapter)!,
          senseAdapter: getSenseAdapter(entry.adapter)!,
          llmAdapter: mockLLMAdapter({
            async chatStream(_messages, _tools, options) {
              options?.observation?.start(options.model)
              return (async function* () {
                for (const event of entry.events) {
                  // Providers can report the same frame before middleware consumes it.
                  options?.observation?.response(event)
                  yield event
                }
                if (failure) throw new Error('final answer interrupted')
              })()
            },
          }),
        },
      })
      runtime.brain.protocol = entry.protocol
      runtime.serverToolScopeId = createServerToolScope(runtime.brain)
      const ctx = createMockContext({
        runtime,
        messages: [{ id: randomUUID(), role: 'user', content: '查找官方资料', createdAt: 1, updateAt: 1 }],
      })
      ctx.soul.chatId = randomUUID()
      const result = collectChunks(chatMiddleware(ctx, makeNext([])))
      if (failure) await expect(result).rejects.toThrow('final answer interrupted')
      else expect((await result).some(chunk => chunk.type === 'stream' && chunk.serverToolDeltas?.length)).toBe(true)
      expect(listServerToolObservations(runtime.serverToolScopeId!).tools).toEqual([
        expect.objectContaining({ name: entry.name, status: 'completed' }),
      ])
      const view = readBrainServiceCapabilities(runtime.brain)
      expect(view.verification.status).toBe('not-verified')
      expect(view.knownTools).toContainEqual(expect.objectContaining({
        name: entry.name, sources: ['observed'],
        observation: expect.objectContaining({ status: 'completed' }),
      }))
      expect(readBrainServiceCapabilities({ ...runtime.brain, key: randomUUID() }).knownTools
        .some(tool => tool.sources.includes('observed'))).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })
  }

  it('非流式 Responses 在请求结束后写入连接记录，不向本地工具输出普通调用', async () => {
    const runtime = createMockRuntime({
      brain: { provider: 'newapi', model: 'offline-model', url: 'https://example.invalid/v1', key: randomUUID() },
      adapters: {
        messageAdapter: getMessageAdapter('openai-responses')!,
        senseAdapter: getSenseAdapter('openai-responses')!,
        llmAdapter: mockLLMAdapter({
          async chat(_messages, _tools, options) {
            options?.observation?.start(options.model)
            return fixture.gpt.response
          },
        }),
      },
    })
    runtime.brain.protocol = 'openai-responses'
    runtime.serverToolScopeId = createServerToolScope(runtime.brain)
    const ctx = createMockContext({
      runtime, global: { stream: false },
      messages: [{ id: randomUUID(), role: 'user', content: '查找官方资料', createdAt: 1, updateAt: 1 }],
    })
    ctx.soul.chatId = randomUUID()
    const output = await collectChunks(chatMiddleware(ctx, makeNext([])))
    expect(output.some(chunk => chunk.type === 'stream' && chunk.senseDelta?.length)).toBe(false)
    expect(listServerToolObservations(runtime.serverToolScopeId!).tools).toEqual([
      expect.objectContaining({ name: 'web_search_call', status: 'completed' }),
    ])
    expect(fetch).not.toHaveBeenCalled()
  })
})
