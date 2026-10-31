import { setTimeout as delay } from 'node:timers/promises'
import type { IngressContext, IngressIdentityHandle, IngressSubject } from '@chery/plugin-api'
import type { QQConfig, QQEventSubmitRequest, SourceReceipt, SourceHandling, SourceReceiptResult, SourceScope,
  SourceAttachmentVersion, SourceSnapshot, QQFileRequestSchemas } from '@chery/protocol'
import type { z } from 'zod'
import type { State } from './state.js'
import { targetOf } from './state.js'

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
const subjectOf = (input: QQEventSubmitRequest): IngressSubject => ({ selfId: input.selfId, userId: input.senderId,
  conversationType: input.conversationType, ...(input.conversationType === 'group' ? { groupId: input.targetId } : {}) })
export const isZipAttachment = (file: { type: string; name?: string; mimeType?: string }) => file.type === 'file' &&
  (/\.zip$/i.test(file.name ?? '') || ['application/zip', 'application/x-zip-compressed'].includes(file.mimeType ?? ''))
type Admission = { connectionId: string; input: QQEventSubmitRequest; scope: SourceScope;
  identity?: IngressIdentityHandle; attachments?: SourceAttachmentVersion[]; deadline: number }
type IdentityCheck = { connectionId: string; eventId: string; entryId: string; subject: IngressSubject }
type FileOperation = keyof typeof QQFileRequestSchemas
type FileInput = z.infer<(typeof QQFileRequestSchemas)[FileOperation]>

/** A short target lock coordinates receipt decisions; downloads and models never hold it. */
export class QQSourceIntake {
  private admissions = new Map<string, Admission>()
  private locks = new Map<string, Promise<unknown>>()
  constructor(private context: IngressContext, private state: State,
    private policy: () => { config: QQConfig; revision: number; enabled: boolean }, private persist: () => void) {}
  private get api() { return this.context.core.sourceConversations ?? fail('SOURCE_CONTEXT_UNAVAILABLE') }
  async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve()
    const current = before.catch(() => {}).then(operation)
    this.locks.set(key, current)
    try { return await current } finally { if (this.locks.get(key) === current) this.locks.delete(key) }
  }
  async configure(connectionId: string, config: QQConfig, revision: number): Promise<void> {
    const targets = Object.entries(config.bindings).flatMap(([target, preset]) => {
      const group = target.startsWith('group:'), targetId = target.slice(group ? 6 : 13)
      if (!(group ? config.groups : config.users).includes(targetId)) return []
      try { return [{ conversationType: group ? 'group' as const : 'private' as const, targetId,
        presetId: this.context.core.resolvePreset(preset).presetId, qqContextEpoch: this.state.contextEpoch }] } catch { return [] }
    })
    targets.sort((a, b) => canonicalTarget(a).localeCompare(canonicalTarget(b)))
    const scopes = await this.api.configure({ entryId: 'qq', channel: 'qq', connectionId, revision, targets })
    // Database application is authoritative. A failed local follow-up must not report policy rollback.
    this.state.sourceScopes = Object.fromEntries(scopes.map((scope, index) => {
      const target = targets[index]
      if (!target) fail('SOURCE_CONFLICT')
      return [target.conversationType === 'group' ? `group:${target.targetId}` : `private:user:${target.targetId}`, scope]
    }))
  }
  verifies(input: IdentityCheck): boolean {
    const admission = this.admissions.get(input.eventId)
    if (!admission || input.entryId !== 'qq' || admission.connectionId !== input.connectionId) return false
    const subject = subjectOf(admission.input)
    if (Object.keys(subject).some(key => subject[key as keyof IngressSubject] !== input.subject[key as keyof IngressSubject])) return false
    try { this.validate(admission.input, admission.scope.scopeId); return true } catch { return false }
  }
  validate(input: QQEventSubmitRequest, scopeId: string): SourceScope {
    const { config, enabled } = this.policy(), target = targetOf(input), scope = this.state.sourceScopes[target]
    if (!enabled || !(input.conversationType === 'group' ? config.groups : config.users).includes(input.targetId) ||
      !scope || scope.scopeId !== scopeId || scope.state !== 'active' || scope.qqContextEpoch !== this.state.contextEpoch ||
      !config.bindings[target] || this.context.core.resolvePreset(config.bindings[target]!).presetId !== scope.presetId) fail('IDENTITY_REJECTED')
    return scope
  }
  async begin(connectionId: string, input: QQEventSubmitRequest): Promise<{ receipt: SourceReceipt; scope: SourceScope }> {
    const scope = this.state.sourceScopes[targetOf(input)] ?? fail('IDENTITY_REJECTED')
    this.validate(input, scope.scopeId)
    const existing = this.admissions.get(input.eventId)
    if (existing && JSON.stringify(existing.input.sourceParts) !== JSON.stringify(input.sourceParts)) fail('SOURCE_CONFLICT')
    const admission: Admission = existing ?? { connectionId, input: structuredClone(input), scope, deadline: Date.now() + 120000 }
    if (admission.connectionId !== connectionId) { admission.connectionId = connectionId; delete admission.identity }
    this.admissions.set(input.eventId, admission)
    admission.identity ??= await this.context.identity.bind({ purpose: 'record', connectionId, entryId: 'qq', channel: 'qq',
      eventId: input.eventId, subject: subjectOf(input) })
    const identity = admission.identity
    const receipt = await this.api.beginReceipt({ entryId: 'qq', identity, scopeId: scope.scopeId,
      message: { eventId: input.eventId, messageId: input.messageId, sender: { id: input.senderId, name: input.senderName },
        platformSentAt: input.occurredAt * 1000, parts: input.sourceParts,
        attachments: (input.attachments ?? []).map(file => ({ partId: file.partId, originalName: file.name,
          declaredMimeType: file.mimeType, mediaKind: file.type === 'image' ? 'image' : file.type === 'video' ? 'video' : file.type === 'record' ? 'audio' : 'file' })) } })
    if (receipt.state === 'pending') admission.attachments = await this.api.receiptAttachments({ entryId: 'qq', identity, scopeId: scope.scopeId })
    if (receipt.state === 'pending') await this.linkImages(admission)
    if (receipt.state === 'completed') {
      const saved = this.state.sourceReceipts[input.eventId]
      if (saved?.receiptId === receipt.receiptId) { saved.pendingReceipt = false; saved.result = receipt.result; this.persist() }
    }
    return { receipt, scope }
  }
  async complete(input: QQEventSubmitRequest, receipt: SourceReceipt, scope: SourceScope, handling: SourceHandling): Promise<SourceReceiptResult> {
    if (receipt.state === 'completed') return receipt.result
    const admission = this.admissions.get(input.eventId) ?? fail('IDENTITY_REJECTED')
    this.state.sourceReceipts[input.eventId] = { scopeId: scope.scopeId, receiptId: receipt.receiptId,
      record: receipt.record, version: receipt.version, subject: subjectOf(input), handling, pendingReceipt: true }
    this.persist()
    const result = await this.api.completeReceipt({ entryId: 'qq', identity: admission.identity!, scopeId: scope.scopeId,
      receiptId: receipt.receiptId, expectedVersion: receipt.version, handling })
    this.state.sourceReceipts[input.eventId]!.pendingReceipt = false
    this.state.sourceReceipts[input.eventId]!.result = result
    this.persist()
    return result
  }
  async lookup(connectionId: string, eventId: string) {
    return this.api.lookupReceipt({ entryId: 'qq', channel: 'qq', connectionId, eventId })
  }
  async repair(connectionId: string): Promise<void> {
    for (const [eventId, link] of Object.entries(this.state.sourceReceipts)) {
      if (!link.pendingReceipt) continue
      const current = await this.lookup(connectionId, eventId)
      if (current.state === 'completed') { link.result = current.result; link.pendingReceipt = false; this.persist(); continue }
      // New process repairs saved handling only. It never constructs a new job or resumes one.
      const admission: Admission = { connectionId, input: { eventId, selfId: link.subject.selfId, senderId: link.subject.userId,
        conversationType: link.subject.conversationType, targetId: link.subject.groupId ?? link.subject.userId } as QQEventSubmitRequest,
        scope: this.state.sourceScopes[link.subject.conversationType === 'group' ? `group:${link.subject.groupId}` : `private:user:${link.subject.userId}`]!, deadline: Date.now() + 120000 }
      if (!admission.scope || admission.scope.scopeId !== link.scopeId) continue
      this.admissions.set(eventId, admission)
      try {
        const identity = await this.context.identity.bind({ purpose: 'record', connectionId, entryId: 'qq', channel: 'qq', eventId, subject: link.subject })
        link.result = await this.api.completeReceipt({ entryId: 'qq', identity, scopeId: link.scopeId,
          receiptId: link.receiptId, expectedVersion: link.version, handling: link.handling })
        link.pendingReceipt = false; this.persist()
      } finally { this.admissions.delete(eventId) }
    }
  }
  ready(eventId: string): boolean { return this.state.sourceReceipts[eventId]?.pendingReceipt === false }
  private async linkImages(admission: Admission): Promise<void> {
    for (const file of admission.input.attachments ?? []) {
      if (file.type !== 'image' || !file.nativeSourceId) continue
      const attachment = admission.attachments?.find(attachment => attachment.source.partId === file.partId)
      if (!attachment || attachment.state.kind === 'stored') continue
      const updated = await this.api.linkImage({ entryId: 'qq', identity: admission.identity!, scopeId: admission.scope.scopeId,
        attachmentId: attachment.attachmentId, nativeSourceId: file.nativeSourceId })
      Object.assign(attachment, updated)
    }
  }
  async refreshImages(snapshot: SourceSnapshot): Promise<void> {
    const records = new Set(snapshot.orderedItems.flatMap(item => item.type === 'message' ? [item.recordId] : []))
    for (const [eventId, admission] of this.admissions) if (admission.scope.scopeId === snapshot.scopeId &&
      records.has(this.state.sourceReceipts[eventId]?.record.recordId ?? '')) await this.linkImages(admission)
  }
  async file(connectionId: string, method: FileOperation, input: FileInput) {
    const admission = this.admissions.get(input.eventId) ?? fail('SOURCE_UNAVAILABLE')
    if (admission.connectionId !== connectionId || !this.verifies({ connectionId, eventId: input.eventId, entryId: 'qq', subject: subjectOf(admission.input) })) fail('IDENTITY_REJECTED')
    const file = admission.input.attachments?.find(file => file.partId === input.partId)
    if (!file || !isZipAttachment(file)) fail('FILE_INVALID')
    const attachment = admission.attachments?.find(a => a.source.partId === input.partId) ?? fail('SOURCE_UNAVAILABLE')
    const access = { entryId: 'qq', identity: admission.identity!, scopeId: admission.scope.scopeId, attachmentId: attachment.attachmentId }
    if (method === 'qq.source.file.unavailable') {
      if (attachment.state.kind === 'stored') return { recorded: true as const }
      const updated = await this.api.updateAttachment({ ...access, expectedVersion: attachment.version,
        state: { kind: 'unavailable', reasonCode: (input as z.infer<typeof QQFileRequestSchemas['qq.source.file.unavailable']>).reasonCode } })
      Object.assign(attachment, updated)
      return { recorded: true as const }
    }
    if (Date.now() >= admission.deadline) fail('SOURCE_UNAVAILABLE')
    if (method === 'qq.source.file.import') {
      const updated = await this.api.importAttachment({ ...access, url: (input as z.infer<typeof QQFileRequestSchemas['qq.source.file.import']>).url,
        signal: AbortSignal.timeout(Math.max(1, admission.deadline - Date.now())) })
      Object.assign(attachment, updated)
      return updated.state.kind === 'stored' ? { state: 'committed' as const, nextOffset: 0,
        assetId: updated.state.assetId, assetVersionId: updated.state.assetVersionId } : fail('SOURCE_UNAVAILABLE')
    }
    if (Date.now() >= admission.deadline) fail('SOURCE_UNAVAILABLE')
    const operation = method.slice('qq.source.file.'.length) as 'reserve' | 'begin' | 'chunk' | 'commit' | 'status' | 'cancel'
    const result = await this.api.publishAttachment({ ...access, ...input, operation })
    if (result.state === 'committed' && result.assetId && result.assetVersionId)
      Object.assign(attachment, await this.api.receiptAttachments(access).then(values => values.find(value => value.attachmentId === attachment.attachmentId)!))
    return result.state === 'registered' ? { ...result, state: 'not_found' as const } : result
  }
  async wait(snapshot: SourceSnapshot, signal: AbortSignal): Promise<void> {
    const records = new Set(snapshot.orderedItems.flatMap(item => item.type === 'message' ? [item.recordId] : []))
    const selected = [...this.admissions.values()].filter(admission => admission.scope.scopeId === snapshot.scopeId &&
      this.state.sourceReceipts[admission.input.eventId] && records.has(this.state.sourceReceipts[admission.input.eventId]!.record.recordId))
    while (selected.some(admission => Date.now() < admission.deadline && admission.attachments?.some(attachment =>
      ['pending', 'acquiring'].includes(attachment.state.kind) && isZipAttachment(admission.input.attachments!.find(file => file.partId === attachment.source.partId)!)))) {
      await delay(20, undefined, { signal })
    }
    signal.throwIfAborted()
    for (const admission of selected) {
      if (Date.now() < admission.deadline) continue
      for (const attachment of admission.attachments ?? []) {
        const file = admission.input.attachments?.find(file => file.partId === attachment.source.partId)
        if (!file || !isZipAttachment(file) || !['pending', 'acquiring'].includes(attachment.state.kind)) continue
        this.validate(admission.input, admission.scope.scopeId)
        const updated = await this.api.updateAttachment({ entryId: 'qq', identity: admission.identity!, scopeId: admission.scope.scopeId,
          attachmentId: attachment.attachmentId, expectedVersion: attachment.version,
          state: { kind: 'unavailable', reasonCode: 'ACQUISITION_TIMEOUT' } })
        Object.assign(attachment, updated)
      }
    }
  }
  invalidate(): void { this.admissions.clear() }
}

function canonicalTarget(target: { conversationType: string; targetId: string; presetId: string; qqContextEpoch: string }): string {
  return JSON.stringify({ conversationType: target.conversationType, presetId: target.presetId, qqContextEpoch: target.qqContextEpoch, targetId: target.targetId })
}
