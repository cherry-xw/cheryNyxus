import { describe, it, expect, vi } from 'vitest'
import { chatMiddleware } from '@/agent/middleware/chat.js'
import { retryMiddleware } from '@/agent/middleware/retry.js'
import { executeRequestTool } from '@/agent/middleware/tool.js'
import { SupervisionLevel } from '@/core/config.js'
import { createMockContext, createMockRuntime, createTestSense, mockLLMAdapter,
  mockMessageAdapter, mockSenseAdapter, makeNext } from '../helpers/fakeContext.js'
import { collectChunks } from '../helpers/chunkAssert.js'
import { registerFunctionHook } from '@/agent/hooks/functions.js'

const execution = { execution: { toolHistory: 'request' as const, retry: 'never' as const }, validate() {} }
describe('request-local tool loop', () => {
  it('applies response rejection before publishing a request-local answer', async () => {
    const release = registerFunctionHook('response-policy', 0, [], new AbortController().signal,
      {event:'PostLLMResponse', handler:()=>({decision:'block'})})
    const ctx = createMockContext({ messages: [{id:'u',role:'user',content:'hello',createdAt:0,updateAt:0}],
      runtime:createMockRuntime({senses:[], adapters:{llmAdapter:mockLLMAdapter({chat:async()=>({content:'rejected-answer'})}),
        messageAdapter:mockMessageAdapter({content:(r:any)=>r.content}),senseAdapter:mockSenseAdapter()}}),
      global:{stream:false,thinking:false,supervision:SupervisionLevel.auto}})
    ctx.requestExecution=execution
    const published: unknown[]=[]
    try {
      await expect((async()=>{for await(const chunk of chatMiddleware(ctx,makeNext([]))) published.push(chunk)})()).rejects.toThrow()
      expect(JSON.stringify(published)).not.toContain('rejected-answer')
    } finally {release()}
  })
  it('does not auto-approve manual tools', async () => {
    const execute = vi.fn(async () => ({ content: 'must not run' }))
    const runtime = createMockRuntime({ senses: [createTestSense('manual_tool', execute)] })
    runtime.senseTable.get('manual_tool')!.supervisionLevel = SupervisionLevel.manual
    const ctx = createMockContext({ runtime, global: { supervision: SupervisionLevel.manual } })
    const generator = executeRequestTool(ctx, 'manual_tool', '{}', 'manual1')
    expect(await generator.next()).toMatchObject({ done: true, value: expect.stringContaining('人工审批') })
    expect(execute).not.toHaveBeenCalled()
  })
  it('never restarts a failed request chain', async () => {
    const ctx = createMockContext({})
    ctx.requestExecution = execution
    const next = vi.fn(async function* () { throw new Error('network request-only-diagnostic') })
    await expect(collectChunks(retryMiddleware(ctx, next))).rejects.toThrow('request-only-diagnostic')
    expect(next).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('classifies model failure once, stream=%s', async stream => {
    const failure = Object.assign(new Error('private-diagnostic'), { status: 529 })
    const chat = vi.fn(async () => { throw failure }), chatStream = vi.fn(async () => { throw failure })
    const ctx = createMockContext({ messages: [{ id: 'u', role: 'user', content: 'hello', createdAt: 0, updateAt: 0 }],
      runtime: createMockRuntime({ senses: [], adapters: { llmAdapter: mockLLMAdapter({ chat, chatStream }),
        messageAdapter: mockMessageAdapter(), senseAdapter: mockSenseAdapter() } }),
      global: { stream, thinking: false, supervision: SupervisionLevel.auto } })
    ctx.requestExecution = execution
    await expect(collectChunks(retryMiddleware(ctx, () => chatMiddleware(ctx, makeNext([]))))).rejects.toMatchObject({
      userMessage: '请求后端模型失败，请稍后再试。', source: 'brain' })
    expect(stream ? chatStream : chat).toHaveBeenCalledTimes(1)
  })
  it('reuses memory context without a maintenance tool; keeps results out of history', async () => {
    const execute = vi.fn(async () => ({ content: 'request-only-tool-result' }))
    const chat = vi.fn().mockResolvedValueOnce({ content: 'intermediate', calls: [{ id: 'tool1', name: 'test_tool', arguments: '{}' }] })
      .mockResolvedValueOnce({ content: 'final answer', calls: [] })
    const ctx = createMockContext({ messages: [{ id: 'u', role: 'user', content: 'hello', createdAt: 0, updateAt: 0 }],
      runtime: createMockRuntime({ senses: [createTestSense('test_tool', execute)], adapters: {
        llmAdapter: mockLLMAdapter({ chat }), messageAdapter: mockMessageAdapter({ content: (r: any) => r.content }),
        senseAdapter: mockSenseAdapter({ senseCalls: (r: any) => r.calls }) } }),
      global: { stream: false, thinking: false, supervision: SupervisionLevel.auto } })
    ctx.requestExecution = execution
    ctx.requestView = { requestId: 'r', inputId: 'u', chatId: 'test-chat', preparedAt: 0, configRevision: 'c', registryVersion: 0,
      identity: { source: 'plugin', ownerId: 'owner', channel: 'qq' }, tools: [], unavailableTools: [],
      contexts: [{ ownerId: 'owner', key: 'qq.memory', content: 'request-only-memory', configRevision: 1 }] }
    const chunks = await collectChunks(chatMiddleware(ctx, makeNext([])))
    expect(chat).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(1)
    for (const call of chat.mock.calls) expect(JSON.stringify(call[0])).toContain('request-only-memory')
    expect(JSON.stringify(chat.mock.calls[1][0])).toContain('request-only-tool-result')
    expect(JSON.stringify(chunks)).toContain('final answer')
    expect(JSON.stringify(chunks)).not.toContain('request-only-tool-result')
    expect(JSON.stringify(ctx.soul.messages)).not.toContain('request-only-')
  })
})
