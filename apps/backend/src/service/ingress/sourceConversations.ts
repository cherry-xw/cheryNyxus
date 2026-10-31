import type { IngressRequestIdentity, IngressSourceAuthorization, IngressSourceConversationsAdapter } from './api.js'
import { SourceContextRepository, sourceContextError, type SourceAuthority } from '@/db/sourceContext.js'
import { getSoulDb } from '@/db/index.js'
import config from '@/utils/config.js'
import path from 'node:path'
import { getAssetStore } from '../media/store.js'
import { SourcePublicationStore, type SourcePublicationContext } from '../media/sourcePublication.js'
import { downloadProviderResult } from '../fileServices/download.js'
import { boundedBody } from '../fileServices/adapters/http.js'
import type { SourceAttachmentVersion } from '@chery/protocol'
import { createHash } from 'node:crypto'
import { readSourceHistory, readSourceText } from '@/db/sourceHistory.js'

function authority(ownerId: string, input: IngressSourceAuthorization): SourceAuthority {
  input.validateIdentity()
  const identity: IngressRequestIdentity = input.requestIdentity
  const subject = identity.subject
  if (identity.source !== 'plugin' || identity.ownerId !== ownerId || !identity.entryId || !identity.channel || !subject)
    sourceContextError('IDENTITY_REJECTED')
  return {
    ownerId, channel: identity.channel, selfId: subject.selfId, conversationType: subject.conversationType,
    targetId: subject.conversationType === 'group' ? subject.groupId! : subject.userId,
    actorId: subject.userId, purpose: input.purpose, validate: input.validateIdentity,
  }
}

/** Lazy main-database access: loading the host does not create a chat or run an Agent. */
export function createSourceConversationsAdapter(isChatBusy?: (chatId: string) => boolean): IngressSourceConversationsAdapter {
  let recovered = false
  const repository = () => {
    const repo = new SourceContextRepository(getSoulDb())
    if (!recovered) { repo.recover(); recovered = true }
    return repo
  }
  let publications: SourcePublicationStore | undefined
  const store = () => {
    if (!publications) {
      publications = new SourcePublicationStore(getSoulDb(), path.resolve(process.env.CHERY_DIR || process.cwd(), '.chery', 'file-staging'), getAssetStore(), 'zip')
      publications.recover()
    }
    return publications
  }
  const publication = (ownerId: string, input: IngressSourceAuthorization & { scopeId: string; attachmentId: string }) => {
    const auth = authority(ownerId, input), repo = repository()
    if (auth.purpose !== 'record') sourceContextError('PERMISSION_DENIED')
    const content = () => repo.receiptContent(auth, input.scopeId, input.eventId)
    const attachment = content().attachments.find(attachment => attachment.attachmentId === input.attachmentId)
    if (!attachment) sourceContextError('PERMISSION_DENIED')
    const validate = () => {
      auth.validate()
      repo.scope(auth, input.scopeId, ['record'])
    }
    const context: SourcePublicationContext = {
      ownerId, sourceKey: attachment.sourceId,
      sourceIdentity: JSON.stringify([input.scopeId, attachment.source, attachment.sourceId]),
      targetKey: `${auth.selfId}:${auth.conversationType}:${auth.targetId}`,
      source: { scopeId: input.scopeId, ...attachment.source }, originalName: attachment.originalName,
      limits: { singleBytes: Math.min(config.files?.maxUploadBytes ?? 104857600, 104857600),
        totalBytes: Number.MAX_SAFE_INTEGER, perTargetBytes: Number.MAX_SAFE_INTEGER }, validate,
    }
    const finish = (result: { state?: string; assetId?: string; assetVersionId?: string }): SourceAttachmentVersion => {
      validate()
      const current = content().attachments.find(attachment => attachment.attachmentId === input.attachmentId)!
      return result.state === 'committed' && result.assetId && result.assetVersionId
        ? repo.updateAttachment(auth, input.scopeId, input.attachmentId, current.version,
          { kind: 'stored', assetId: result.assetId, assetVersionId: result.assetVersionId }) : current
    }
    return { context, finish, attachment }
  }
  return {
    history: async (ownerId, input) => readSourceHistory(repository(), authority(ownerId, input), input),
    readText: async (ownerId, input) => readSourceText(repository(), authority(ownerId, input), input),
    prepareSummary: async (ownerId, input) => {
      const repo = repository(), auth = repo.maintenanceAuthority({ ownerId, channel: input.channel,
        selfId: input.selfId, validate: input.validateIdentity }, input.scopeId)
      return repo.prepareMaintenanceSummary(auth, input.scopeId, input)
    },
    summaryStatus: async (ownerId, input) => {
      const repo = repository(), auth = repo.maintenanceAuthority({ ownerId, channel: input.channel,
        selfId: input.selfId, validate: input.validateIdentity }, input.scopeId)
      return repo.summaryStatus(auth, input.scopeId, input.operationId)
    },
    updateSummaryProgress: async (ownerId, input) => {
      const repo = repository(), auth = repo.maintenanceAuthority({ ownerId, channel: input.channel,
        selfId: input.selfId, validate: input.validateIdentity }, input.scopeId)
      return repo.updateSummaryProgress(auth, input.scopeId, input)
    },
    commitSummary: async (ownerId, input) => {
      const repo = repository(), auth = repo.maintenanceAuthority({ ownerId, channel: input.channel,
        selfId: input.selfId, validate: input.validateIdentity }, input.scopeId)
      const operation = repo.summaryStatus(auth, input.scopeId, input.operationId)
      if (operation.purpose === 'discussion') {
        const scope = repo.scope(auth, input.scopeId, ['maintenance'])
        if (scope.coreBinding && isChatBusy?.(scope.coreBinding.chatId)) sourceContextError('SUMMARY_FOREGROUND_PRIORITY')
      }
      return repo.commitSummary(auth, input.scopeId, input, input.validatePrerequisite)
    },
    lookupReceipt: async (ownerId, input) => repository().lookupReceipt({ ownerId, ...input }),
    recordDelivery: async (ownerId, input) => {
      input.validateIdentity()
      if (input.frame.data.selfId !== input.selfId || input.channel !== 'qq') sourceContextError('IDENTITY_REJECTED')
      repository().recordDelivery({ ownerId, channel: input.channel, selfId: input.selfId,
        conversationType: input.frame.data.conversationType, targetId: input.frame.data.targetId,
        validate: input.validateIdentity }, input.scopeId, input.frame, input.result, input.confirmedAt)
    },
    scope: async (ownerId, input) => repository().scope(authority(ownerId, input), input.scopeId),
    receiptAttachments: async (ownerId, input) => {
      return repository().receiptContent(authority(ownerId, input), input.scopeId, input.eventId).attachments
    },
    configure: async (ownerId, input) => repository().applyScopes({ ownerId, channel: input.channel,
      selfId: input.selfId, validate: input.validateIdentity }, input.revision, input.targets),
    ensureScope: async (ownerId, input) => repository().ensureScope(authority(ownerId, input), input.presetId, input.qqContextEpoch),
    beginReceipt: async (ownerId, input) => {
      if (input.eventId !== input.message.eventId) sourceContextError('IDENTITY_REJECTED')
      return repository().beginReceipt(authority(ownerId, input), input.scopeId, input.message)
    },
    completeReceipt: async (ownerId, input) => repository().completeReceipt(authority(ownerId, input), input.receiptId,
      input.expectedVersion, input.handling, input.scopeId, input.eventId),
    receiptStatus: async (ownerId, input) => {
      // This API only describes the authenticated receipt. It does not authorize a caller-chosen event.
      return repository().receiptStatus(authority(ownerId, input), input.eventId)
    },
    freeze: async (ownerId, input) => repository().freeze(authority(ownerId, input), input.scopeId, input),
    read: async (ownerId, input) => repository().readSelection(authority(ownerId, input), input.scopeId, input.selection),
    snapshot: async (ownerId, input) => repository().snapshot(authority(ownerId, input), input.scopeId, input.snapshotId),
    attachment: async (ownerId, input) => repository().attachment(authority(ownerId, input), input.scopeId, input.attachmentId, input.version),
    registerWorkspace: async (ownerId, input) => {
      const auth = authority(ownerId, input), repo = repository()
      const attachment = repo.attachment(auth, input.scopeId, input.attachmentId, input.version)
      if (attachment.state.kind !== 'stored') sourceContextError('ASSET_UNAVAILABLE')
      const asset = getAssetStore().get(attachment.state.assetId, { ownerId, sourceScopeId: input.scopeId }, attachment.state.assetVersionId)
      if (asset.mimeType !== 'application/zip' || asset.sha256 !== input.mount.sha256 || asset.sizeBytes !== input.mount.sizeBytes) sourceContextError('SOURCE_CONFLICT')
      repo.registerWorkspace(auth, input.scopeId, input.attachmentId, input.version, input.mount)
    },
    linkImage: async (ownerId, input) => {
      const auth = authority(ownerId, input), repo = repository()
      const { record, attachments } = repo.receiptContent(auth, input.scopeId, input.eventId)
      const attachment = attachments.find(attachment => attachment.attachmentId === input.attachmentId)
      if (!attachment || attachment.mediaKind !== 'image') sourceContextError('IDENTITY_REJECTED')
      const row = getSoulDb().prepare(`SELECT identity_json,state,asset_id,version_id,chat_id FROM ingress_image_sources
        WHERE owner_id=? AND source_key=? AND target_key=? AND permitted=1`)
        .get(ownerId, input.nativeSourceId, `${auth.selfId}:${auth.conversationType}:${auth.targetId}`) as
        { identity_json: string; state: string; asset_id: string; version_id: string; chat_id: string } | undefined
      if (!row || row.state !== 'committed') return attachment
      if (attachment.state.kind === 'stored') {
        if (attachment.state.assetId !== row.asset_id || attachment.state.assetVersionId !== row.version_id) sourceContextError('SOURCE_CONFLICT')
        return attachment
      }
      const [selfId, source] = JSON.parse(row.identity_json)
      const images = record.parts.filter(part => part.type === 'attachment').filter(part =>
        attachments.find(attachment => attachment.attachmentId === part.attachmentId)?.mediaKind === 'image')
      if (selfId !== auth.selfId || source.senderId !== record.sender.id || source.messageId !== record.platformMessageIds[0] ||
        source.conversationType !== auth.conversationType || source.targetId !== auth.targetId ||
        images[source.elementOrdinal]?.partId !== attachment.source.partId) sourceContextError('SOURCE_CONFLICT')
      return getSoulDb().transaction(() => {
        auth.validate(); repo.scope(auth, input.scopeId, ['record'])
        getAssetStore().get(row.asset_id, { ownerId, chatId: row.chat_id }, row.version_id)
        getSoulDb().prepare(`INSERT OR IGNORE INTO source_asset_grants(asset_id,asset_version_id,scope_id,record_id,part_id,record_revision)
          VALUES (?,?,?,?,?,?)`).run(row.asset_id, row.version_id, input.scopeId, record.recordId, attachment.source.partId, record.revision)
        return repo.updateAttachment(auth, input.scopeId, input.attachmentId, attachment.version,
          { kind: 'stored', assetId: row.asset_id, assetVersionId: row.version_id })
      })()
    },
    updateAttachment: async (ownerId, input) => {
      const auth = authority(ownerId, input), repo = repository()
      if (auth.purpose === 'record' && !repo.receiptContent(auth, input.scopeId, input.eventId).attachments
        .some(attachment => attachment.attachmentId === input.attachmentId)) sourceContextError('PERMISSION_DENIED')
      return repo.updateAttachment(auth, input.scopeId, input.attachmentId, input.expectedVersion, input.state)
    },
    publishAttachment: async (ownerId, input) => {
      const { context, finish } = publication(ownerId, input), ledger = store()
      let result
      switch (input.operation) {
        case 'reserve': result = ledger.reserve(context, input.size!); break
        case 'begin': result = ledger.begin(context, { size: input.size!, sha256: input.sha256!, mimeType: 'application/zip' }); break
        case 'chunk': return ledger.chunk(context, { uploadId: input.uploadId!, offset: input.offset!, dataBase64: input.dataBase64! })
        case 'status': result = ledger.status(context); break
        case 'cancel': return ledger.cancel(context, input.uploadId!)
        case 'commit': result = await ledger.commit(context, { uploadId: input.uploadId!, size: input.size!, sha256: input.sha256! }); break
        default: sourceContextError('INVALID_PARAMS')
      }
      finish(result)
      return result
    },
    importAttachment: async (ownerId, input) => {
      const { context, finish, attachment } = publication(ownerId, input)
      if (attachment.state.kind === 'stored') return attachment
      const signal = input.signal ?? new AbortController().signal
      signal.throwIfAborted(); context.validate()
      const response = await downloadProviderResult(input.url, signal)
      const body = await boundedBody(response, context.limits.singleBytes, signal)
      signal.throwIfAborted(); context.validate()
      const sha256 = createHash('sha256').update(body).digest('hex'), ledger = store()
      const begun = ledger.begin(context, { size: body.length, sha256, mimeType: 'application/zip' })
      if (begun.state === 'committed') return finish(begun)
      if (begun.state !== 'uploading') sourceContextError('UPLOAD_ABORTED')
      for (let offset = begun.nextOffset; offset < body.length;) {
        signal.throwIfAborted(); context.validate()
        offset = ledger.chunk(context, { uploadId: begun.uploadId!, offset, dataBase64: body.subarray(offset, offset + 65536).toString('base64') }).nextOffset
      }
      signal.throwIfAborted(); context.validate()
      return finish(await ledger.commit(context, { uploadId: begun.uploadId!, size: body.length, sha256 }))
    },
    readAttachmentChunk: async (ownerId, input) => {
      const auth = authority(ownerId, input)
      if (auth.purpose !== 'execution') sourceContextError('PERMISSION_DENIED')
      const attachment = repository().attachment(auth, input.scopeId, input.attachmentId, input.version)
      if (attachment.state.kind !== 'stored') sourceContextError('ASSET_UNAVAILABLE')
      const result = await getAssetStore().readChunk(attachment.state.assetId, { ownerId, sourceScopeId: input.scopeId },
        attachment.state.assetVersionId, input.offset)
      repository().scope(auth, input.scopeId)
      return result
    },
  }
}
