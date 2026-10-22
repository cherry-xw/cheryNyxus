import { afterEach, expect, it, vi } from 'vitest'
import { registerOpenAIAdapter } from '@/agent/provider/openai.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter } from '@/core/message/adapter.js'
import { getSenseAdapter } from '@/core/sense/adapter.js'
import { contextRecoveryAdapter } from '@/agent/middleware/contextRecovery.js'
import { createMockContext, createMockRuntime } from '../helpers/fakeContext.js'
const metadata: Record<string, any> = {}
vi.mock('@/db/chat.js', () => ({ getChatMetadata: () => metadata, updateChatMetadata: (_id: string, patch: object) => Object.assign(metadata, patch) }))
afterEach(() => { vi.unstubAllGlobals(); for (const key of Object.keys(metadata)) delete metadata[key] })
it('actual provider body is budgeted before transport and the accepted projection publishes the same snapshot', async () => {
  registerOpenAIAdapter()
  const messageAdapter = getMessageAdapter('openai')!
  const llmAdapter = getLLMAdapter('openai')!
  const senseAdapter = getSenseAdapter('openai')!
  const runtime = createMockRuntime({ adapters: { llmAdapter, messageAdapter, senseAdapter } })
  runtime.brain.contextLimit = 32000
  const ctx = createMockContext({ runtime })
  const source = [{ id: 'old', role: 'assistant' as const, content: '中文资料'.repeat(6000), createdAt: 0, updateAt: 0 }, { id: 'current', role: 'user' as const, content: '继续原任务', createdAt: 0, updateAt: 0 }]
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body)
    const summarizing = body.messages[0]?.content?.includes('整理成可继续任务的摘要')
    return Response.json({ choices: [{ message: { role: 'assistant', content: summarizing ? '有来源的历史摘要；继续原任务。' : '原任务完成' }, finish_reason: 'stop' }] })
  }))
  const report = vi.fn((value: object) => { metadata.modelInputBudget = value })
  const options = { model: 'test', protocol: 'openai-chat-completions' as const, url: 'https://offline.invalid/v1', key: 'synthetic', continuous: true, inputPreflight: { contextLimit: 32000, safetyMargin: 1000, trigger: { unit: 'percent' as const, value: 0.5 }, compactIfNeeded: true, report } }
  const adapter = contextRecoveryAdapter(ctx, () => source, history => messageAdapter.buildMessages(history))
  const result = await adapter.chat(messageAdapter.buildMessages(source), [], options)
  expect(messageAdapter.content(result)).toBe('原任务完成')
  expect(bodies.length).toBeGreaterThan(1)
  expect(bodies.every(body => !JSON.stringify(body).includes('中文资料'.repeat(6000)))).toBe(true)
  expect(metadata.contextCheckpoint).toMatchObject({ status: 'completed', coveredMessageIds: ['old'] })
  const { measureModelInput } = await import('@/agent/provider/inputBudget.js')
  expect(metadata.modelInputBudget.projectionId).toBe(measureModelInput(bodies.at(-1)).projectionId)
  expect(report).toHaveBeenCalledTimes(2)
  expect(source[0]!.content).toHaveLength(24000)
})
