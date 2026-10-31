import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareContextCheckpoint, applyContextCheckpoint } from '@/agent/middleware/contextCheckpoint.js'
import { createMockContext, createMockRuntime, mockLLMAdapter, mockMessageAdapter, mockSenseAdapter } from '../helpers/fakeContext.js'

const metadata: Record<string, unknown> = {}
vi.mock('@/db/chat.js', () => ({ getChatMetadata: () => metadata, updateChatMetadata: (_id: string, patch: Record<string, unknown>) => Object.assign(metadata, patch) }))
beforeEach(() => { for (const k of Object.keys(metadata)) delete metadata[k] })
const message = (id: string, role: 'user' | 'assistant' | 'system', content: string) => ({ id, role, content, createdAt: 0, updateAt: 0 })
function setup(text = '已完成文件读取；仍需继续原任务。') {
  const chat = vi.fn(async () => ({ text }))
  const runtime = createMockRuntime({ brain: { contextLimit: 128000 }, adapters: { llmAdapter: mockLLMAdapter({ chat }), messageAdapter: mockMessageAdapter({ content: (r: any) => r.text }), senseAdapter: mockSenseAdapter({ senseCalls: () => [] }) } })
  runtime.brain.contextLimit = 128000
  const ctx = createMockContext({ runtime })
  return { ctx, chat }
}

describe('durable context checkpoints', () => {
  it('does not import checkpoints owned by a different conversation', () => {
    const source = [message('u', 'user', 'branch anchor')]
    metadata.contextCheckpoint = { chatId: 'other-chat', status: 'completed', summary: 'future fact', coveredMessageIds: ['later'] }
    expect(applyContextCheckpoint('test-chat', source)).toBe(source)
  })
  it('keeps an entire tool batch when an associated result has an asset', async () => {
    const { ctx } = setup()
    const call = { ...message('call', 'assistant', ''), senseCalls: [{ id: 't', name: 'read', arguments: '{}' }] }
    const result = { id: 't', role: 'sense' as const, content: 'asset result', parts: [{ partId: 'asset', type: 'asset' as const, assetId: 'fixture', versionId: 'v1' }], createdAt: 0, updateAt: 0 }
    const source = [message('old', 'user', 'old'), call, result, message('u', 'user', 'continue')]
    const projected = await prepareContextCheckpoint(ctx, source as any, { model: 'test' }, true)
    expect(projected.map(m => m.id)).toContain('call')
    expect(projected.map(m => m.id)).toContain('t')
    expect((metadata.contextCheckpoint as any).coveredMessageIds).not.toContain('call')
  })
  it('splits oversized evidence and retains completed current tool batches in the summary', async () => {
    const { ctx, chat } = setup()
    ctx.runtime!.brain.contextLimit = 16000
    const source = [message('u', 'user', 'continue'), { ...message('call', 'assistant', ''), senseCalls: [{ id: 'result', name: 'read_file', arguments: '{}' }] }, { id: 'result', role: 'sense' as const, content: '证据'.repeat(20000), createdAt: 0, updateAt: 0 }]
    const projected = await prepareContextCheckpoint(ctx, source, { model: 'test' }, true)
    expect(chat.mock.calls.length).toBeGreaterThan(1)
    expect(projected.some(m => m.id === 'u')).toBe(true)
    expect(metadata.contextCheckpoint).toMatchObject({ coveredMessageIds: ['call', 'result'] })
    expect(source[2]!.content).toHaveLength(40000)
  })
  it('does not publish until exact final projection is accepted', async () => {
    const { ctx } = setup()
    const source = [message('old', 'assistant', 'fact'), message('u', 'user', 'continue')]
    await prepareContextCheckpoint(ctx, source, { model: 'test' }, true, true)
    expect(metadata.contextCheckpoint).toBeUndefined()
    expect(metadata.contextMaintenance).toMatchObject({ status: 'completed', chatId: ctx.soul.chatId })
  })
  it('invalidates saved partials when the input budget changes', async () => {
    const { ctx, chat } = setup()
    const source = [message('old', 'assistant', 'fact'), message('u', 'user', 'continue')]
    await prepareContextCheckpoint(ctx, source, { model: 'test' }, true, true)
    const first = metadata.contextMaintenance as any
    ctx.runtime!.brain.contextLimit = 64000
    await prepareContextCheckpoint(ctx, source, { model: 'test' }, true, true)
    expect((metadata.contextMaintenance as any).operationId).not.toBe(first.operationId)
    expect(chat).toHaveBeenCalledTimes(2)
  })
  it('a superseded operation cannot overwrite newer maintenance on failure', async () => {
    const { ctx, chat } = setup()
    chat.mockImplementationOnce(async () => {
      metadata.contextMaintenance = { operationId: 'newer', status: 'running' }
      throw new Error('old operation failed')
    })
    await expect(prepareContextCheckpoint(ctx, [message('old', 'assistant', 'fact'), message('u', 'user', 'continue')], { model: 'test' }, true, true)).rejects.toThrow()
    expect(metadata.contextMaintenance).toEqual({ operationId: 'newer', status: 'running' })
  })
  it('a successful stale partial cannot replace newer maintenance', async () => {
    const { ctx, chat } = setup()
    chat.mockImplementationOnce(async () => {
      metadata.contextMaintenance = { operationId: 'newer', status: 'running' }
      return { text: 'late old summary' }
    })
    await expect(prepareContextCheckpoint(ctx, [message('old', 'assistant', 'fact'), message('u', 'user', 'continue')], { model: 'test' }, true, true)).rejects.toThrow('superseded')
    expect(metadata.contextMaintenance).toEqual({ operationId: 'newer', status: 'running' })
    expect(metadata.contextCheckpoint).toBeUndefined()
  })
  it('does not call a model for small requests', async () => {
    const { ctx, chat } = setup(); const source = [message('u', 'user', 'hello')]
    expect(await prepareContextCheckpoint(ctx, source, { model: 'test' })).toBe(source)
    expect(chat).not.toHaveBeenCalled()
  })
  it('publishes summary and exact coverage together without changing raw history', async () => {
    const { ctx, chat } = setup()
    const source = [message('s', 'system', 'trusted system'), message('old-u', 'user', 'old question'), message('old-a', 'assistant', 'old answer'), message('current', 'user', 'continue')]
    const copy = structuredClone(source)
    const projected = await prepareContextCheckpoint(ctx, source, { model: 'test' }, true)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(source).toEqual(copy)
    expect(projected.map(m => m.id)).toEqual(['s', expect.stringContaining('context-checkpoint:'), 'current'])
    expect(metadata.contextCheckpoint).toMatchObject({ status: 'completed', coveredMessageIds: ['old-u', 'old-a'] })
    expect(applyContextCheckpoint(ctx.soul.chatId, source).map(m => m.id)).toEqual(projected.map(m => m.id))
    expect(chat.mock.calls[0]?.[1]).toEqual([])
  })
  it('failure preserves previous checkpoint and records terminal failure', async () => {
    const previous = { status: 'completed', summary: 'previous', coveredMessageIds: ['earlier'] }
    metadata.contextCheckpoint = previous
    const { ctx } = setup('')
    await expect(prepareContextCheckpoint(ctx, [message('old', 'assistant', 'fact'), message('u', 'user', 'continue')], { model: 'test' }, true)).rejects.toThrow()
    expect(metadata.contextCheckpoint).toEqual(previous)
    expect(metadata.contextMaintenance).toMatchObject({ status: 'failed' })
  })
  it('newer input is outside the published coverage after restart projection', async () => {
    const { ctx } = setup()
    const source = [message('a', 'assistant', 'fact'), message('u', 'user', 'continue')]
    await prepareContextCheckpoint(ctx, source, { model: 'test' }, true)
    expect(applyContextCheckpoint(ctx.soul.chatId, [...source, message('later', 'user', 'new')]).map(m => m.id)).toContain('later')
  })
})
