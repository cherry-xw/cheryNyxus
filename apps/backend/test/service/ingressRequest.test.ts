import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerFunctionHook } from '@/agent/hooks/functions.js'
import { prepareRequest, finishRequest } from '@/agent/hooks/request.js'
import { checkpointMiddleware } from '@/agent/middleware/checkpoint.js'
import { chatMiddleware } from '@/agent/middleware/chat.js'
import { registerPluginSense } from '@/core/sense/senseRegistry.js'
import {
  createMockContext,
  createMockRuntime,
  createTestSense,
} from '../agent/helpers/fakeContext.js'
import { collectChunks } from '../agent/helpers/chunkAssert.js'

const releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
})
function hook(
  event: Parameters<typeof registerFunctionHook>[4]['event'],
  handler: Parameters<typeof registerFunctionHook>[4]['handler'],
) {
  releases.push(
    registerFunctionHook('snapshot', 0, [], new AbortController().signal, { event, handler }),
  )
}
describe('real request preparation and model history', () => {
  it('prepares once per input, reuses frozen context across model loops, then refreshes without saving it in history', async () => {
    let revision = 1
    const prepare = vi.fn(() => ({
      contexts: [{ key: 'policy', content: `policy-${revision}`, configRevision: revision }],
    }))
    hook('RequestPrepare', prepare)
    const modelHistories: unknown[][] = []
    const runtime = createMockRuntime({
      adapters: {
        llmAdapter: {
          chat: async (messages) => {
            modelHistories.push(structuredClone(messages) as unknown[])
            return {}
          },
          chatStream: vi.fn(),
        },
      },
    })
    const ctx = createMockContext({
      runtime,
      userInputs: [{ content: 'first', time: 1 }],
      global: { stream: false },
    })
    const refreshed = vi.fn()
    ctx.refreshRequestRuntime = refreshed
    await collectChunks(checkpointMiddleware(ctx, () => chatMiddleware(ctx, async function* () {})))
    const view = ctx.requestView!
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.contexts)).toBe(true)
    revision = 2
    await collectChunks(checkpointMiddleware(ctx, () => chatMiddleware(ctx, async function* () {})))
    expect(ctx.requestView).toBe(view)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(modelHistories[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('policy-1') }),
      ]),
    )
    expect(modelHistories[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('policy-1') }),
      ]),
    )
    expect(ctx.soul.messages.some((message) => message.content.includes('policy-'))).toBe(false)
    ctx.journal.appendUserInput('second')
    await collectChunks(checkpointMiddleware(ctx, () => chatMiddleware(ctx, async function* () {})))
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(refreshed).toHaveBeenCalledTimes(2)
    expect(ctx.requestView?.contexts[0]?.configRevision).toBe(2)
    expect(ctx.requestView?.requestId).not.toBe(view.requestId)
  })
  it('separates queued inputs and reports only one request terminal event', async () => {
    const completed = vi.fn()
    hook('RequestCompleted', completed)
    const prepared = vi.fn(() => ({}))
    hook('RequestPrepare', prepared)
    const ctx = createMockContext({
      userInputs: [
        { content: 'one', time: 1 },
        { content: 'two', time: 2 },
      ],
    })
    await collectChunks(checkpointMiddleware(ctx, async function* () {}))
    expect(ctx.soul.userInputs.map((input) => input.content)).toEqual(['two'])
    await finishRequest(ctx, 'completed')
    await finishRequest(ctx, 'completed')
    expect(completed).toHaveBeenCalledTimes(1)
    await collectChunks(checkpointMiddleware(ctx, async function* () {}))
    expect(prepared).toHaveBeenCalledTimes(2)
  })
  it('filters channel tools before generating schema and freezes the same filtered catalogue', async () => {
    const tool = createTestSense('native_private', async () => ({ content: 'private' }))
    releases.push(
      registerPluginSense(tool, { source: 'plugin', pluginId: 'native', channels: ['native'] }),
    )
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [tool] }) })
    await prepareRequest(ctx, { content: 'web input', time: 1 })
    expect(ctx.runtime?.builtSenses).toEqual([])
    expect(ctx.runtime?.senseTable.has('native_private')).toBe(false)
    expect(ctx.requestView?.unavailableTools).toContainEqual(
      expect.objectContaining({ name: 'native_private', reason: 'identity_required' }),
    )
  })
  it('does not invoke preparation for a revoked queued identity', async () => {
    const prepare = vi.fn()
    hook('RequestPrepare', prepare)
    const ctx = createMockContext({})
    await expect(
      prepareRequest(ctx, {
        content: 'queued',
        time: 1,
        requestExecution: {
          validate() {
            throw new Error('IDENTITY_REJECTED')
          },
        },
      }),
    ).rejects.toThrow('IDENTITY_REJECTED')
    expect(prepare).not.toHaveBeenCalled()
  })
})
