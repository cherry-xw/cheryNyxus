import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorId } from '@chery/protocol'
import { ClassifiedError } from '@/utils/error.js'
import { contextRecoveryAdapter } from '@/agent/middleware/contextRecovery.js'
import { createMockContext, createMockRuntime, mockLLMAdapter } from '../helpers/fakeContext.js'
const metadata: Record<string, any> = {}
const prepare = vi.hoisted(() => vi.fn(async (_ctx: unknown, source: unknown) => source))
vi.mock('@/db/chat.js', () => ({ getChatMetadata: () => metadata, updateChatMetadata: (_id: string, patch: object) => Object.assign(metadata, patch) }))
vi.mock('@/agent/middleware/contextCheckpoint.js', () => ({ applyContextCheckpoint: (_id: string, source: unknown) => source, prepareContextCheckpoint: prepare }))
beforeEach(() => { vi.clearAllMocks(); for (const key of Object.keys(metadata)) delete metadata[key] })
const overflow = () => new ClassifiedError({ errorId: ErrorId.BRAIN_CONTEXT_OVERFLOW, category: 'validation', source: 'brain', message: 'overflow', userMessage: 'overflow' })
const m = (id: string, role: 'user' | 'sense', content: string) => ({ id, role, content, createdAt: 0, updateAt: 0 })
describe('one rejected-start recovery per current model step', () => {
  it('rebuilds with newly executed tool results rather than initial user-only history', async () => {
    const chat = vi.fn().mockRejectedValueOnce(overflow()).mockResolvedValue({ text: 'ok' })
    const ctx = createMockContext({ runtime: createMockRuntime({ adapters: { llmAdapter: mockLLMAdapter({ chat }) } }) })
    const source = [m('u', 'user', 'question'), m('tool-1', 'sense', 'verified tool result')]
    const adapter = contextRecoveryAdapter(ctx, () => source, current => structuredClone(current))
    await adapter.chat([], [], { model: 'test' })
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1]![0]).toContainEqual(expect.objectContaining({ id: 'tool-1', content: 'verified tool result' }))
    expect(prepare).toHaveBeenCalledTimes(1)
    chat.mockRejectedValueOnce(overflow())
    await expect(contextRecoveryAdapter(ctx, () => source, current => current).chat([], [], { model: 'test' })).rejects.toMatchObject({ errorId: ErrorId.BRAIN_CONTEXT_OVERFLOW })
    expect(prepare).toHaveBeenCalledTimes(1)
  })
  it('never publishes a candidate from a different maintenance operation', async () => {
    const chat = vi.fn().mockRejectedValueOnce(overflow()).mockImplementationOnce(async (_messages, _tools, options) => {
      metadata.contextMaintenance = { chatId: ctx.soul.chatId, operationId: 'newer', status: 'completed', summary: 'unvalidated' }
      options.inputPreflight.accepted()
      return { text: 'ok' }
    })
    const ctx = createMockContext({ runtime: createMockRuntime({ adapters: { llmAdapter: mockLLMAdapter({ chat }) } }) })
    prepare.mockImplementationOnce(async (_ctx, source) => {
      metadata.contextMaintenance = { chatId: ctx.soul.chatId, operationId: 'accepted-candidate', status: 'completed', summary: 'validated' }
      return source
    })
    await contextRecoveryAdapter(ctx, () => [m('u', 'user', 'question')], current => current).chat([], [], { model: 'test', inputPreflight: { contextLimit: 128000, report() {} } })
    expect(metadata.contextCheckpoint).toBeUndefined()
  })
  it('does not recover stream-consumption failures or replay visible output', async () => {
    const stream = async function* () { yield { text: 'visible' }; throw overflow() }
    const chatStream = vi.fn(async () => stream())
    const ctx = createMockContext({ runtime: createMockRuntime({ adapters: { llmAdapter: mockLLMAdapter({ chatStream }) } }) })
    const adapter = contextRecoveryAdapter(ctx, () => [m('u', 'user', 'question')], current => current)
    const iterator = await adapter.chatStream([], [], { model: 'test' })
    const chunks = []
    await expect((async () => { for await (const chunk of iterator) chunks.push(chunk) })()).rejects.toThrow()
    expect(chunks).toEqual([{ text: 'visible' }])
    expect(chatStream).toHaveBeenCalledTimes(1)
    expect(prepare).not.toHaveBeenCalled()
  })
  it('uses source-owned recovery and preserves tools instead of applying Core text checkpoints', async () => {
    const chat=vi.fn().mockRejectedValueOnce(overflow()).mockResolvedValue({text:'ok'})
    const ctx=createMockContext({runtime:createMockRuntime({adapters:{llmAdapter:mockLLMAdapter({chat})}})})
    const rebuilt=[m('source-child','user','固定来源摘要'),m('tool','sense','真实工具结果')]
    const recover=vi.fn(async()=>rebuilt)
    const options={model:'test',inputPreflight:{contextLimit:128000,report(){}}}
    await contextRecoveryAdapter(ctx,()=>[m('u','user','本次输入')],current=>current,recover).chat([],[],options)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(prepare).not.toHaveBeenCalled()
    expect(chat.mock.calls[1]![0]).toEqual(rebuilt)
    expect(chat.mock.calls[1]![2].inputPreflight).toMatchObject({compactIfNeeded:false,afterCompaction:true})
  })
})
