import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSoulDb } from '@/db/index.js'
import { createChat, getChat, updateChatMetadata } from '@/db/chat.js'
import { ensureActiveChatEpoch, rotateActiveChatEpoch } from '@/db/epoch.js'
import { BackendResumeRepository } from '@/db/backendResume.js'
import * as pendingInputs from '@/db/pendingInput.js'
import { SourceContextRepository } from '@/db/sourceContext.js'
import { ensureCurrentConfigRevision } from '@/service/config/revision.js'
import { createSourceConversationsAdapter } from '@/service/ingress/sourceConversations.js'
import { ingressExecution } from '@/service/ingress/request.js'
import { sourceExecutionAuthority } from '@/service/ingress/sourceExecution.js'
import { configureBackendWork } from '@/service/backendWork.js'
import { BackendStopCoordinator } from '@/service/backendStopCoordinator.js'
import { handleChatInputSubmit } from '@/service/chat/input.js'
import * as runtime from '@/service/chat/runtime.js'
import * as send from '@/service/chat/send.js'
import { chatRuntimes } from '@/service/chat/runtimeCache.js'
import type { HandlerContext } from '@/service/message/router.js'

afterEach(() => { configureBackendWork(undefined); chatRuntimes.clear(); vi.restoreAllMocks() })
let sourceRevision = 0

async function fixture() {
  const db = getSoulDb(), chatId = randomUUID(), commandId = randomUUID(), ownerId = 'cherynyxus-qq-module'
  createChat(chatId)
  const { epoch } = ensureActiveChatEpoch({ chatId, revisionId: ensureCurrentConfigRevision().revisionId })
  const resume = new BackendResumeRepository(db)
  resume.recover([chatId])
  const coordinator = new BackendStopCoordinator({ backendInstanceId: randomUUID(), parkInputs: () => 0,
    restoreInputs() {}, blockers: () => [], close() {}, force() {} })
  configureBackendWork({ coordinator, resume, canContinue: () => false })
  const queue: any[] = [], builder = { isRunning: vi.fn(() => false), getPendingInputs: () => queue,
    enqueueInput: vi.fn((content: string, meta: object) => { const entry = { content, ...meta }; queue.push(entry); return entry }),
    removeInput: vi.fn(({ inputId }: { inputId: string }) => { const at = queue.findIndex(item => item.inputId === inputId); if (at < 0) return false; queue.splice(at, 1); return true }) }
  chatRuntimes.set(chatId, { builder: builder as any })
  vi.spyOn(runtime, 'ensureChat').mockResolvedValue(builder as any)
  const runner = vi.spyOn(send, 'handleChatSend').mockImplementation(async function* () { return {} as any })
  const validate = vi.fn(() => {}), source = createSourceConversationsAdapter()
  const identity = { source: 'plugin' as const, ownerId, entryId: 'qq', channel: 'qq',
    subject: { selfId: '123', userId: '789', conversationType: 'group' as const, groupId: '456' } }
  const [scope] = await source.configure(ownerId, { channel: 'qq', selfId: '123', revision: ++sourceRevision,
    targets: [{ conversationType: 'group', targetId: '456', presetId: randomUUID(), qqContextEpoch: chatId }], validateIdentity: validate })
  updateChatMetadata(chatId, { presetId: scope!.presetId })
  const auth = { scopeId: scope!.scopeId, eventId: commandId, requestIdentity: identity, validateIdentity: validate }
  const receipt = await source.beginReceipt(ownerId, { ...auth, purpose: 'record',
    message: { eventId: commandId, messageId: String(sourceRevision), sender: { id: '789', name: 'fixture' }, receivedAt: Date.now(), parts: [{ type: 'text', partId: 'p0', text: 'new request' }] } })
  await source.completeReceipt(ownerId, { ...auth, purpose: 'record', receiptId: receipt.receiptId, expectedVersion: receipt.version, handling: { kind: 'queued', requestId: commandId } })
  const snapshot = await source.freeze(ownerId, { ...auth, purpose: 'execution', requestId: commandId,
    actorRecord: receipt.record, inputRecords: [receipt.record], expectedSelectionRevision: 0,
    policy: { historyLimit: 10, backgroundMaxAgeMs: 60000, backgroundMaxChars: 5000, qqConfigRevision: 1 } })
  new SourceContextRepository(db).bindCore(sourceExecutionAuthority(identity, validate), scope!.scopeId, { chatId, epochId: epoch.epochId })
  const execution: NonNullable<ReturnType<typeof ingressExecution.getStore>> = { identity, validate,
    execution: { toolHistory: 'request', retry: 'never' }, sourceInput: { kind: 'source_snapshot', requestId: commandId,
      turnId: commandId, scopeId: scope!.scopeId, snapshotId: snapshot.snapshotId, actorRecord: receipt.record, inputRecords: [receipt.record] } }
  const input = { chatId, commandId, clientMessageId: randomUUID(), messageId: randomUUID(), content: '' }
  const ctx = { requestId: randomUUID(), connectionId: 'qq-restart-test' } as HandlerContext
  const submit = () => ingressExecution.run(execution, () => handleChatInputSubmit(ctx, input))
  const oldInput = (state: pendingInputs.PendingInputRow['state']) => pendingInputs.addPendingInput({ inputId: randomUUID(),
    chatId, messageId: randomUUID(), commandId: randomUUID(), content: 'old', state, queueSequence: 1, acceptedAt: 1 })
  return { db, chatId, commandId, resume, coordinator, builder, queue, runner, validate, execution, input, ctx, submit, oldInput, scope: scope!, epoch }
}

describe('new QQ input after Backend restart', () => {
  it.each(['before-submit', 'during-runtime-init'])('retains the source scope after a configuration epoch change %s', async timing => {
    const f = await fixture(), repo = new SourceContextRepository(f.db), authority = sourceExecutionAuthority(f.execution.identity, f.validate)
    const rotate = () => rotateActiveChatEpoch({ chatId: f.chatId, transitionReason: 'configuration-changed', handoffSummary: '' })
    if (timing === 'before-submit') rotate()
    else vi.spyOn(runtime, 'ensureChat').mockImplementation(async () => { rotate(); return f.builder as any })
    const snapshot = repo.snapshot(authority, f.scope.scopeId, f.execution.sourceInput!.snapshotId)
    f.oldInput('cancelled')
    await expect(f.submit()).resolves.toMatchObject({ state: 'started' })
    const epochId = getChat(f.chatId)!.active_epoch_id!
    expect(epochId).not.toBe(f.epoch.epochId)
    expect(repo.scope(authority, f.scope.scopeId)).toMatchObject({ scopeId: f.scope.scopeId, presetId: f.scope.presetId,
      coreBinding: { chatId: f.chatId, epochId }, permissionRevision: f.scope.permissionRevision })
    expect(repo.snapshot(authority, f.scope.scopeId, snapshot.snapshotId)).toEqual(snapshot)
    expect(f.db.prepare('SELECT epoch_id FROM source_tasks WHERE request_id=?').get(f.commandId)).toEqual({ epoch_id: epochId })
    expect(f.db.prepare("SELECT state FROM pending_inputs WHERE chat_id=? AND content='old'").get(f.chatId)).toEqual({ state: 'cancelled' })
    expect(f.runner).toHaveBeenCalledTimes(1)
    expect(f.resume.required(f.chatId)).toBe(false)
  })
  it.each(['other-chat', 'old-epoch', 'reset', 'preset', 'revoked'])('rejects a %s rebind', async kind => {
    const f = await fixture(), repo = new SourceContextRepository(f.db), authority = sourceExecutionAuthority(f.execution.identity, f.validate)
    const next = rotateActiveChatEpoch({ chatId: f.chatId, transitionReason: kind === 'reset' ? 'manual-reset' : 'configuration-changed', handoffSummary: '' })
    if (kind === 'preset') updateChatMetadata(f.chatId, { presetId: 'another-preset' })
    if (kind === 'revoked') f.validate.mockImplementation(() => { throw Object.assign(new Error('revoked'), { code: 'PERMISSION_DENIED' }) })
    if (kind === 'old-epoch') repo.bindCore(authority, f.scope.scopeId, { chatId: f.chatId, epochId: next.epochId })
    expect(() => repo.bindCore(authority, f.scope.scopeId, { chatId: kind === 'other-chat' ? 'other-chat' : f.chatId,
      epochId: kind === 'old-epoch' ? f.epoch.epochId : next.epochId })).toThrow(kind === 'revoked' ? 'revoked' : 'SOURCE_CONFLICT')
  })
  it('rolls back the source binding if admission fails after configuration changes', async () => {
    const f = await fixture(), repo = new SourceContextRepository(f.db), authority = sourceExecutionAuthority(f.execution.identity, f.validate)
    rotateActiveChatEpoch({ chatId: f.chatId, transitionReason: 'configuration-changed', handoffSummary: '' })
    vi.spyOn(pendingInputs, 'addPendingInput').mockImplementationOnce(() => { throw new Error('fixture persistence failure') })
    await expect(f.submit()).rejects.toThrow('fixture persistence failure')
    expect(repo.scope(authority, f.scope.scopeId).coreBinding?.epochId).toBe(f.epoch.epochId)
    expect(f.resume.required(f.chatId)).toBe(true)
    expect(f.runner).not.toHaveBeenCalled()
  })
  it('admits only the new input with an empty queue, without continuing cancelled history', async () => {
    const f = await fixture()
    f.oldInput('cancelled')
    const result = await f.submit()
    expect(result).toMatchObject({ state: 'started', queueSequence: 1 })
    expect(f.resume.required(f.chatId)).toBe(false)
    expect(f.runner).toHaveBeenCalledTimes(1)
    expect(f.runner.mock.calls[0]?.[1]).toMatchObject({ inputAlreadyQueued: true, inputMeta: { commandId: f.commandId } })
    expect(f.queue).toHaveLength(1)
    expect(f.queue[0].sourceInput.requestId).toBe(f.commandId)
    expect(f.db.prepare("SELECT state FROM pending_inputs WHERE chat_id=? AND content='old'").get(f.chatId)).toEqual({ state: 'cancelled' })
    expect(pendingInputs.listPendingInputs(f.chatId).map(row => row.command_id)).toEqual([f.commandId])
  })
  it.each(['accepted', 'queued', 'started'] as const)('rejects old durable %s inputs', async state => {
    const f = await fixture(); f.oldInput(state)
    await expect(f.submit()).rejects.toMatchObject({ code: 'PREVIOUS_WORK_PENDING' })
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.runner).not.toHaveBeenCalled()
  })
  it.each(['memory', 'agent', 'active-run'])('rejects %s work even if the durable queue is empty', async kind => {
    const f = await fixture()
    if (kind === 'memory') f.queue.push({ content: 'old' })
    if (kind === 'agent') f.builder.isRunning.mockReturnValue(true)
    if (kind === 'active-run') chatRuntimes.get(f.chatId)!.activeRunId = 'old-run'
    await expect(f.submit()).rejects.toMatchObject({ code: 'PREVIOUS_WORK_PENDING' })
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.runner).not.toHaveBeenCalled()
  })
  it('keeps ordinary Web inputs queued behind the explicit continue gate', async () => {
    const f = await fixture()
    const result = await handleChatInputSubmit(f.ctx, { ...f.input, content: 'web input' })
    expect(result).toMatchObject({ state: 'queued', queueSequence: 2 })
    expect(f.resume.required(f.chatId)).toBe(true)
  })
  it.each(['owner', 'entry', 'channel', 'missing-source'])('does not grant the exception to %s inputs', async kind => {
    const f = await fixture()
    if (kind === 'owner') f.execution.identity = { ...f.execution.identity, ownerId: 'other-plugin' }
    if (kind === 'entry') f.execution.identity = { ...f.execution.identity, entryId: 'other' }
    if (kind === 'channel') f.execution.identity = { ...f.execution.identity, channel: 'other' }
    if (kind === 'missing-source') { delete f.execution.sourceInput; f.input.content = 'other input' }
    await expect(f.submit()).rejects.toMatchObject({ code: kind === 'owner' || kind === 'channel' ? 'PERMISSION_DENIED' : 'BACKEND_RESUME_REQUIRED' })
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.runner).not.toHaveBeenCalled()
  })
  it.each(['command', 'turn', 'actor', 'binding'])('rejects a mismatched %s', async kind => {
    const f = await fixture()
    if (kind === 'command') f.input.commandId = randomUUID()
    if (kind === 'turn') f.execution.sourceInput!.turnId = randomUUID()
    if (kind === 'actor') f.execution.identity = { ...f.execution.identity, subject: { ...f.execution.identity.subject!, userId: '999' } }
    if (kind === 'binding') f.db.prepare('UPDATE chats SET active_epoch_id=NULL WHERE id=?').run(f.chatId)
    await expect(f.submit()).rejects.toMatchObject({ code: kind === 'binding' ? 'SOURCE_CONTEXT_UNAVAILABLE' : 'IDENTITY_REJECTED' })
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.runner).not.toHaveBeenCalled()
  })
  it('revalidates permission after runtime initialization', async () => {
    const f = await fixture()
    vi.spyOn(runtime, 'ensureChat').mockImplementation(async () => {
      f.validate.mockImplementation(() => { throw Object.assign(new Error('revoked'), { code: 'PERMISSION_DENIED' }) })
      return f.builder as any
    })
    await expect(f.submit()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.runner).not.toHaveBeenCalled()
  })
  it('rolls back the gate and memory enqueue when durable input persistence fails', async () => {
    const f = await fixture()
    vi.spyOn(pendingInputs, 'addPendingInput').mockImplementationOnce(() => { throw new Error('fixture persistence failure') })
    await expect(f.submit()).rejects.toThrow('fixture persistence failure')
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.queue).toEqual([])
    expect(pendingInputs.listPendingInputs(f.chatId)).toEqual([])
    expect(f.db.prepare('SELECT 1 FROM request_journal WHERE request_id=?').get(f.commandId)).toBeUndefined()
    expect(f.runner).not.toHaveBeenCalled()
  })
  it('does not clear a later gate on duplicate or conflicting command IDs', async () => {
    const f = await fixture(), first = await f.submit()
    f.resume.recover([f.chatId])
    expect(await f.submit()).toEqual(first)
    f.input.messageId = randomUUID()
    await expect(f.submit()).rejects.toThrow('commandId')
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.runner).toHaveBeenCalledTimes(1)
  })
  it('does not admit a second concurrent input into request-local work', async () => {
    const f = await fixture(), second = { ...f.input, commandId: randomUUID(), messageId: randomUUID() }
    const results = await Promise.allSettled([f.submit(), ingressExecution.run(f.execution, () => handleChatInputSubmit(f.ctx, second))])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'PREVIOUS_WORK_PENDING' } })
    expect(f.queue).toHaveLength(1); expect(f.runner).toHaveBeenCalledTimes(1)
  })
  it('does not start new work if shutdown begins during runtime initialization', async () => {
    const f = await fixture()
    vi.spyOn(runtime, 'ensureChat').mockImplementation(async () => {
      f.coordinator.request(randomUUID())
      return f.builder as any
    })
    await expect(f.submit()).rejects.toMatchObject({ code: 'BACKEND_STOPPING' })
    expect(f.resume.required(f.chatId)).toBe(true); expect(f.runner).not.toHaveBeenCalled()
    expect(getChat(f.chatId)).toBeDefined()
  })
})
