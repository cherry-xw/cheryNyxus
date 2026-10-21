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
  it('real Core rejects stale summary snapshots and preserves newer history',async()=>{
    const { createChat, deleteChat } = await import('@/db/chat.js')
    const { addMessage, getMessages } = await import('@/db/message.js')
    const { createIngressCoreAdapter } = await import('@/service/ingress/coreAdapter.js')
    const { createHash, randomUUID } = await import('node:crypto')
    const owner='summary-fixture',key='summary-conversation'
    const chatId=`ingress-${owner}-${createHash('sha256').update(key).digest('hex')}`
    const { resolvePresetSelection } = await import('@/agent/runtimeResolver.js')
    createChat(chatId, { presetId: resolvePresetSelection('detail-test').presetId })
    const core=createIngressCoreAdapter()
    try {
      await core.ensureConversation(owner,key,'detail-test')
      addMessage(randomUUID(),chatId,{role:'user',content:'first'})
      const history=await core.conversationHistory!(owner,key)
      addMessage(randomUUID(),chatId,{role:'user',content:'arrived later'})
      await expect(core.commitSummary!(owner,key,'candidate',history,'conflict-attempt')).rejects.toMatchObject({code:'SUMMARY_CONFLICT'})
      expect(getMessages(chatId).some(m=>m.context_compaction)).toBe(false)
      const fresh=await core.conversationHistory!(owner,key)
      await core.commitSummary!(owner,key,'validated summary',fresh,'successful-attempt')
      expect(getMessages(chatId).filter(m=>m.context_compaction)).toHaveLength(1)
      expect(await core.summaryCommitStatus!(owner,key,'successful-attempt')).toMatchObject({committed:true})
      await core.commitSummary!(owner,key,'validated summary',fresh,'successful-attempt')
      expect(getMessages(chatId).filter(m=>m.context_compaction)).toHaveLength(1)
      await expect(core.commitSummary!(owner,key,'different',fresh,'successful-attempt')).rejects.toThrow('conflict')
    } finally { deleteChat(chatId) }
  })
  it('real Core repairs cross-database partial writes and protects accepted idle builders',async()=>{
    const { createChat, deleteChat, getChat, updateChatMetadata } = await import('@/db/chat.js')
    const { addMessage, getMessages } = await import('@/db/message.js')
    const { createIngressCoreAdapter } = await import('@/service/ingress/coreAdapter.js')
    const { chatRuntimes } = await import('@/service/chat/runtimeCache.js')
    const { getSoulDb } = await import('@/db/index.js')
    const { resolvePresetSelection } = await import('@/agent/runtimeResolver.js')
    const { createHash } = await import('node:crypto')
    const owner='summary-repair',key='partial',op='same-op'
    const chatId=`ingress-${owner}-${createHash('sha256').update(key).digest('hex')}`
    const messageId=`summary-${createHash('sha256').update(JSON.stringify([owner,key,op])).digest('hex')}`
    createChat(chatId,{presetId:resolvePresetSelection('detail-test').presetId})
    const core=createIngressCoreAdapter(),db=getSoulDb()
    try {
      await core.ensureConversation(owner,key,'detail-test')
      addMessage('summary-source',chatId,{role:'user',content:'x'.repeat(190000)})
      const history=await core.conversationHistory!(owner,key)
      expect(history.length).toBeGreaterThan(180000)
      updateChatMetadata(chatId,{contextCheckpoint:{kept:true},modelInputBudget:{stale:true}})
      // Fail after monthly INSERT, rolling back the soul-side count/link/metadata.
      db.exec(`CREATE TEMP TRIGGER fail_summary_link BEFORE INSERT ON message_links WHEN NEW.message_id='${messageId}' BEGIN SELECT RAISE(ABORT,'injected partial failure'); END`)
      await expect(core.commitSummary!(owner,key,'summary',history,op)).rejects.toThrow('injected partial')
      db.exec('DROP TRIGGER fail_summary_link')
      expect(getMessages(chatId).filter(m=>m.id===messageId)).toHaveLength(1)
      expect(await core.summaryCommitStatus!(owner,key,op)).toEqual({committed:false})
      const dispose=vi.fn()
      chatRuntimes.set(chatId,{builder:{isRunning:()=>false,getPendingInputs:()=>[{content:'accepted'}],dispose} as any})
      await expect(core.commitSummary!(owner,key,'summary',history,op)).rejects.toMatchObject({code:'SUMMARY_FOREGROUND_PRIORITY'})
      expect(dispose).not.toHaveBeenCalled()
      chatRuntimes.delete(chatId)
      const restored=createIngressCoreAdapter();await restored.ensureConversation(owner,key,'detail-test')
      await restored.commitSummary!(owner,key,'summary',history,op)
      expect(await restored.summaryCommitStatus!(owner,key,op)).toEqual({committed:true,messageId})
      expect(getMessages(chatId).filter(m=>m.context_compaction)).toHaveLength(1)
      expect(getChat(chatId)?.message_count).toBe(2)
      expect(JSON.parse(getChat(chatId)!.metadata!)).toMatchObject({contextCheckpoint:null,modelInputBudget:null})
      expect(db.prepare('SELECT 1 FROM message_links WHERE message_id=?').get(messageId)).toBeTruthy()
      await restored.commitSummary!(owner,key,'summary',history,op)
      expect(getChat(chatId)?.message_count).toBe(2)
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_summary_link');chatRuntimes.delete(chatId)
      db.prepare('DELETE FROM ingress_summary_commits WHERE chat_id=?').run(chatId);deleteChat(chatId)
    }
  })
  it('resolves QQ image capability from the captured request config instead of later global state', async () => {
    const { captureRuntimeConfig } = await import('@/utils/config.js')
    const config = structuredClone(captureRuntimeConfig())
    config.llm.brain.snapshot = { model: 'offline', provider: 'openai', protocol: 'openai-chat-completions', capabilities: { input: { image: 'supported' }, imageInput: { formats: ['image/png'], maxBytes: 1234 } } }
    config.roles = { snapshot: { id: 'role-snapshot', brain: 'snapshot', senseGroup: 'empty', permissions: { template: 'trusted' } } }
    const runtime = createMockRuntime({})
    runtime.configSnapshot = config
    runtime.selectionSnapshot = { brain: 'snapshot', senseGroup: 'empty', mcpServers: [] }
    runtime.roleSecurity = { ...runtime.roleSecurity, roleType: 'snapshot' } as typeof runtime.roleSecurity
    const { createChat, deleteChat } = await import('@/db/chat.js')
    const { randomUUID } = await import('node:crypto')
    const id = randomUUID()
    createChat(id, { type: 'snapshot' })
    const ctx = createMockContext({ runtime })
    ctx.soul.chatId = id
    try {
      await prepareRequest(ctx, { content: 'offline', time: 1 })
      expect(ctx.requestView?.fileCapabilities?.find(item => item.operation === 'image.inspect')).toMatchObject({ availability: 'available', mode: 'native', targetId: 'snapshot', inputConstraints: { mimeTypes: ['image/png'], maxBytes: 1234 } })
      expect(Object.isFrozen(ctx.requestView?.fileCapabilities)).toBe(true)
    } finally { deleteChat(id) }
  })
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
