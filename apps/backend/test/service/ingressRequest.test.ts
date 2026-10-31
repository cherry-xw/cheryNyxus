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
  it('sourceConversations rejects stale summary snapshots, foreground conflicts, and conflicting retries while preserving idempotency',async()=>{
    const { createIngressCoreAdapter } = await import('@/service/ingress/coreAdapter.js')
    const { SourceContextRepository } = await import('@/db/sourceContext.js')
    const { getSoulDb } = await import('@/db/index.js')
    const { chatRuntimes } = await import('@/service/chat/runtimeCache.js')
    const { createChat, deleteChat } = await import('@/db/chat.js')
    const { resolvePresetSelection } = await import('@/agent/runtimeResolver.js')
    const { randomUUID } = await import('node:crypto')
    const owner='summary-fixture',selfId='12345',targetId='67890',presetId=resolvePresetSelection('detail-test').presetId
    const core=createIngressCoreAdapter(),source=core.sourceConversations!,chatId=`summary-chat-${randomUUID()}`
    createChat(chatId,{presetId})
    const validateIdentity=()=>{}
    const [scope]=await source.configure(owner,{channel:'qq',selfId,revision:1,targets:[{conversationType:'group',targetId,presetId,qqContextEpoch:''}],validateIdentity})
    new SourceContextRepository(getSoulDb()).bindCore({ownerId:owner,channel:'qq',selfId,conversationType:'group',targetId,actorId:'22222',purpose:'execution',validate:validateIdentity},scope!.scopeId,{chatId,epochId:'epoch-1'})
    const ingest=async(eventId:string,messageId:string,text:string)=>{
      const receipt=await source.beginReceipt(owner,{
        scopeId:scope!.scopeId,eventId,purpose:'record',validateIdentity,
        requestIdentity:{source:'plugin',ownerId:owner,entryId:'qq',channel:'qq',subject:{selfId,userId:'22222',conversationType:'group',groupId:targetId}},
        message:{eventId,messageId,sender:{id:'22222',name:'Alice'},receivedAt:100,parts:[{partId:'p0',type:'text',text}]},
      })
      await source.completeReceipt(owner,{
        scopeId:scope!.scopeId,eventId,purpose:'record',validateIdentity,receiptId:receipt.receiptId,expectedVersion:receipt.version,
        requestIdentity:{source:'plugin',ownerId:owner,entryId:'qq',channel:'qq',subject:{selfId,userId:'22222',conversationType:'group',groupId:targetId}},
        handling:{kind:'background'},
      })
      return receipt
    }
    try {
      await ingest('ev-1','101','first')
      await source.prepareSummary(owner,{channel:'qq',selfId,scopeId:scope!.scopeId,operationId:'op-1',purpose:'discussion',qqConfigRevision:1,validateIdentity})
      const later=await ingest('ev-2','102','arrived later')
      await source.freeze(owner,{
        scopeId:scope!.scopeId,eventId:'ev-2',purpose:'execution',validateIdentity,
        requestIdentity:{source:'plugin',ownerId:owner,entryId:'qq',channel:'qq',subject:{selfId,userId:'22222',conversationType:'group',groupId:targetId}},
        requestId:'req-2',actorRecord:later.record,inputRecords:[later.record],expectedSelectionRevision:0,
        policy:{historyLimit:10,backgroundMaxAgeMs:60000,backgroundMaxChars:5000,qqConfigRevision:1},
      })
      await expect(source.commitSummary(owner,{channel:'qq',selfId,scopeId:scope!.scopeId,operationId:'op-1',
        text:'stale',prerequisiteReceipt:'r1',validatePrerequisite:()=>true,validateIdentity})).rejects.toMatchObject({code:'SUMMARY_CONFLICT'})
      await source.prepareSummary(owner,{channel:'qq',selfId,scopeId:scope!.scopeId,operationId:'op-2',purpose:'discussion',qqConfigRevision:1,validateIdentity})
      chatRuntimes.set(chatId,{builder:{isRunning:()=>true,getPendingInputs:()=>[],dispose:vi.fn()} as any})
      await expect(source.commitSummary(owner,{channel:'qq',selfId,scopeId:scope!.scopeId,operationId:'op-2',
        text:'validated summary',prerequisiteReceipt:'r2',validatePrerequisite:()=>true,validateIdentity})).rejects.toMatchObject({code:'SUMMARY_FOREGROUND_PRIORITY'})
      chatRuntimes.delete(chatId)
      const committed=await source.commitSummary(owner,{channel:'qq',selfId,scopeId:scope!.scopeId,operationId:'op-2',
        text:'validated summary',prerequisiteReceipt:'r2',validatePrerequisite:()=>true,validateIdentity})
      expect(committed.text).toBe('validated summary')
      const replayed=await source.commitSummary(owner,{channel:'qq',selfId,scopeId:scope!.scopeId,operationId:'op-2',
        text:'validated summary',prerequisiteReceipt:'r2',validatePrerequisite:()=>true,validateIdentity})
      expect(replayed.summaryId).toBe(committed.summaryId)
      await expect(source.commitSummary(owner,{channel:'qq',selfId,scopeId:scope!.scopeId,operationId:'op-2',
        text:'different',prerequisiteReceipt:'r2',validatePrerequisite:()=>true,validateIdentity})).rejects.toMatchObject({code:'SOURCE_CONFLICT'})
    } finally {
      chatRuntimes.delete(chatId);deleteChat(chatId)
      getSoulDb().prepare("DELETE FROM source_summaries WHERE scope_id=?").run(scope!.scopeId)
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
