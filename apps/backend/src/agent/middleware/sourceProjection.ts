import { createHash, randomUUID } from 'node:crypto'
import type { LLMOptions, InputTokenPreflight } from '@/core/llm/adapter.js'
import type { RequestObservation, ModelUsage } from '@/core/llm/usage.js'
import type { LLMResponse } from '@/core/message/adapter.js'
import { inputOrigins } from '@/core/message/inputOrigins.js'
import { sourceFingerprint } from '@/db/sourceContext.js'
import { extractModelUsage } from '@/agent/provider/usage.js'
import type { SourceAttempt, SourceDataRef, SourceFileProvision, SourceManifestItem, SourceModelProjection } from '@chery/protocol'
import type { FileInputProjection } from './fileInputPlanning.js'
import type { PreparedSourceHistory } from './sourceHistory.js'
import type { MiddlewareContext } from '@/core/middleware/types.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')

/** A logical model step may prepare multiple versions, but each version invokes at most once. */
export function sourceModelStep(ctx: MiddlewareContext, source: PreparedSourceHistory, history: LLMResponse[], files: FileInputProjection,
  options: LLMOptions, parent: RequestObservation | undefined, reason: 'initial' | 'tool_continue' | 'question_resume' | 'approval_resume',
  stepId?: string) {
  const { repo, authority, input } = source, scopeId = input.scopeId
  const modelStepId = stepId ?? `model-step-${randomUUID()}`
  let attempt: SourceAttempt | undefined, protocol = options.protocol ?? options.provider ?? 'unknown'
  let usage: ModelUsage = {}, budget: InputTokenPreflight | undefined, responseSeen = false
  let complete: ReturnType<typeof repo.attemptCompletion> | undefined
  const byMessage = new Map(history.map(message => [message.id, message]))
  const savedTools = new Map(repo.runMessages(authority, scopeId, input.requestId).map(message => [message.body.id, message.ref]))
  const boundary: NonNullable<LLMOptions['sourceCall']> = {
    budget(value) { budget = value },
    prepare(body, wireProtocol) {
      authority.validate()
      protocol = wireProtocol
      if (attempt?.state === 'invoking') throw new Error('SOURCE_CALL_STILL_RUNNING')
      if (attempt?.state === 'prepared') attempt = complete!('failed', false, undefined)
      const saved = repo.db.transaction(() => {
        const dataRefs = new Map<string, SourceDataRef>()
        const descriptions = new Map<string, SourceDataRef>()
        const manifests: SourceManifestItem[] = [], matchedMessages = new Set<string>(), seenToolMessages = new Set<string>()
        const fileInputs: SourceFileProvision[] = source.fileInputs.map(file => ({ ...file, modelStepId }))
        for (const decision of files.plan ?? []) {
          const message = byMessage.get(decision.messageId), original = message?.sourceRecord
          const partId = message?.sourcePartIds?.[decision.partId]
          if (!message || !original || !partId) continue
          const at = fileInputs.findIndex(file => file.source.recordId === original.recordId && file.source.revision === original.revision && file.source.partId === partId)
          const previous = fileInputs[at]
          if (!previous || previous.representation !== 'metadata_only') continue
          if (decision.action === 'describe' && decision.description) {
            const descriptionId = `description-${randomUUID()}`
            const data: SourceDataRef = { dataId: descriptionId, revision: 1, kind: 'description',
              provenance: { kind: 'description', descriptionId, version: 1, source: previous.source } }
            const body = message.parts?.find(part => part.type === 'text' && part.partId === decision.partId)
            if (!body || body.type !== 'text') throw new Error('SOURCE_INPUT_MAPPING_UNAVAILABLE')
            repo.saveDataSnapshot(authority, scopeId, data, body.text)
            descriptions.set(`${decision.messageId}:${decision.partId}`, data)
            dataRefs.set(descriptionId, data)
            fileInputs[at] = { provisionId: previous.provisionId, source: previous.source, attachmentVersion: previous.attachmentVersion,
              acquisitionState: previous.acquisitionState, inputOrigin: previous.inputOrigin, modelStepId,
              assetId: previous.assetId, assetVersionId: previous.assetVersionId,
              representation: 'description', descriptionId, version: 1,
              sourceType: decision.description.source === 'user' ? 'user' : 'service', userDescriptionOnly: decision.description.source === 'user',
              observationRef: repo.savePreparationResult(authority, scopeId, 'description', decision.description) }
          } else if (decision.action !== 'native' && decision.reasonCode) fileInputs[at] = { ...previous, reasonCode: decision.reasonCode }
        }
        const list = body.input ?? body.messages
        if (!Array.isArray(list)) throw new Error('SOURCE_INPUT_MAPPING_UNAVAILABLE')
        for (const [messageIndex, rawMessage] of list.entries()) {
          const message = object(rawMessage)
          const blocks = Array.isArray(message.content) ? message.content : [rawMessage]
          for (const [blockIndex, block] of blocks.entries()) {
            const value = object(block)
            for (const origin of inputOrigins(block)) {
              const original = byMessage.get(origin.messageId)
              if (!original) continue
              const partId = origin.partId && original.sourcePartIds?.[origin.partId]
              let sourceRef: SourceManifestItem['sourceRef'] | undefined
              if (original.sourceRecord) sourceRef = { kind: 'record', record: { recordId: original.sourceRecord.recordId,
                revision: original.sourceRecord.revision }, ...(partId ? { partId } : {}) }
              else if (original.sourceItem) sourceRef = original.sourceItem.type === 'summary'
                ? { kind: 'summary', summaryId: original.sourceItem.summaryId, revision: original.sourceItem.revision }
                : { kind: 'gap', snapshotItemId: original.id }
              else if (original.sourceData) {
                let data = dataRefs.get(original.id)
                if (!data) {
                  const dataId = `data-${randomUUID()}`, meta = original.sourceData
                  // An aggregate context is frozen as its own entry, never assigned a mutable config's revision.
                  data = meta.kind === 'memory' ? { dataId, revision: 1, kind: 'memory',
                    provenance: { kind: 'memory', entryId: dataId, entryRevision: 1 } }
                    : { dataId, revision: 1, kind: 'execution_notice', provenance: { kind: 'execution_notice', factId: meta.key, revision: meta.revision } }
                  repo.saveDataSnapshot(authority, scopeId, data, original.content)
                  dataRefs.set(original.id, data)
                }
                sourceRef = { kind: 'data', data }
              } else if (savedTools.has(original.id)) {
                if (seenToolMessages.has(original.id)) continue
                seenToolMessages.add(original.id)
                sourceRef = { kind: 'tool', message: savedTools.get(original.id)! }
              }
              if (!sourceRef) continue
              matchedMessages.add(original.id)
              const position = { messageIndex, blockIndex }
              let provision: SourceFileProvision | undefined
              if (origin.attachment && original.sourceRecord && partId) {
                const at = fileInputs.findIndex(file => file.source.recordId === original.sourceRecord!.recordId && file.source.partId === partId)
                const previous = fileInputs[at]
                if (!previous || previous.assetId !== origin.attachment.assetId || previous.assetVersionId !== origin.attachment.assetVersionId)
                  throw new Error('SOURCE_INPUT_MAPPING_UNAVAILABLE')
                const payload = origin.attachment, sha256 = digest(payload.data)
                const transportRef = repo.savePreparationResult(authority, scopeId, 'transport', { assetId: payload.assetId,
                  assetVersionId: payload.assetVersionId, mimeType: payload.mimeType, binaryBytes: payload.data.length, sha256 })
                provision = { provisionId: previous.provisionId, source: previous.source, attachmentVersion: previous.attachmentVersion,
                  acquisitionState: previous.acquisitionState, inputOrigin: previous.inputOrigin, modelStepId,
                  assetId: previous.assetId, assetVersionId: previous.assetVersionId, representation: 'native',
                  actualMimeType: payload.mimeType, transportRef, binaryBytes: payload.data.length, inputBlockPosition: position, transformRef: transportRef }
                fileInputs[at] = provision
              }
              const rendered = typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content
                : typeof value.output === 'string' ? value.output : undefined
              manifests.push({ itemId: `input-item-${randomUUID()}`, sourceRef, position,
                representation: provision ? 'native' : rendered !== undefined ? 'text' : 'reference',
                ...(provision ? { provisionId: provision.provisionId } : rendered !== undefined
                  ? { renderedTextRef: repo.saveRenderedText(authority, scopeId, rendered), ...(origin.range ? { range: origin.range } : {}) } : {}) })
              const description = descriptions.get(`${origin.messageId}:${origin.partId}`)
              if (description && rendered !== undefined) manifests.push({ itemId: `input-item-${randomUUID()}`,
                sourceRef: { kind: 'data', data: description }, position, representation: 'text',
                renderedTextRef: repo.saveRenderedText(authority, scopeId, rendered), ...(origin.range ? { range: origin.range } : {}) })
            }
          }
        }
        for (const decision of files.plan ?? []) if (decision.sharedWith) {
           const original = byMessage.get(decision.messageId)
           const partId = original?.sourcePartIds?.[decision.partId]
           const at = fileInputs.findIndex(file => file.source.recordId === original?.sourceRecord?.recordId && file.source.partId === partId)
           const previous = fileInputs[at]
           const representative = fileInputs.find(file => file.representation === 'native' && file.assetId === decision.sharedWith!.assetId && file.assetVersionId === decision.sharedWith!.assetVersionId)
           if (!previous || !representative || representative.representation !== 'native') continue
           fileInputs[at] = { provisionId: previous.provisionId, source: previous.source, attachmentVersion: previous.attachmentVersion,
             acquisitionState: previous.acquisitionState, inputOrigin: previous.inputOrigin, modelStepId,
             assetId: previous.assetId, assetVersionId: previous.assetVersionId,
             representation: 'metadata_only', reasonCode: 'shared_representation', sharedProvisionId: representative.provisionId }
           manifests.push({ itemId: `input-item-${randomUUID()}`, sourceRef: { kind: 'record', record: {
             recordId: previous.source.recordId, revision: previous.source.revision }, partId: previous.source.partId },
             position: representative.inputBlockPosition, representation: 'reference', provisionId: representative.provisionId })
        }
        for (const message of history) if ((message.sourceRecord || message.sourceItem || message.sourceData || savedTools.has(message.id)) &&
          !matchedMessages.has(message.id)) throw new Error('SOURCE_INPUT_MAPPING_UNAVAILABLE')
        const projection: SourceModelProjection = { projectionId: `projection-${randomUUID()}`, modelStepId, snapshotId: source.snapshot.snapshotId,
          runtimeConfigRevision: ctx.requestView!.configRevision, registryVersion: ctx.requestView!.registryVersion,
          model: String(body.model ?? options.model), protocol: options.protocol ?? protocol,
          toolNames: Array.isArray(body.tools) ? body.tools.map(tool => String(object(object(tool).function).name ?? object(tool).name ?? '')).filter(Boolean) : [],
          fileInputs, dataContextRefs: [...dataRefs.values()], executionFactRefs: [],
          toolHistoryRefs: [...savedTools.values()].filter(ref => matchedMessages.has(ref.messageId)), orderedInputManifest: manifests,
          ...(budget ? { budgetSnapshotId: repo.savePreparationResult(authority, scopeId, 'budget', budget) } : {}),
          contentFingerprint: sourceFingerprint(body) }
        repo.saveProjection(authority, scopeId, projection, reason)
        const prepared = repo.prepareAttempt(authority, scopeId, projection.projectionId, `attempt-${randomUUID()}`)
        return { attempt: prepared, complete: repo.attemptCompletion(authority, scopeId, prepared.attemptId) }
      })()
      attempt = saved.attempt; complete = saved.complete
      usage = {}; responseSeen = false
    },
  }
  const observation: RequestObservation = {
    start(model) {
      options.signal?.throwIfAborted()
      if (!attempt) throw new Error('SOURCE_PROJECTION_NOT_PREPARED')
      if (attempt.state === 'invoking') return
      if (attempt.state !== 'prepared') throw new Error('SOURCE_CALL_ALREADY_FINISHED')
      attempt = repo.invokeAttempt(authority, scopeId, attempt.attemptId, input.turnId, files.commit).attempt
      parent?.start(model)
    },
    response(raw) {
      if (!attempt?.startedAt || !['invoking', 'unknown', 'cancelled'].includes(attempt.state)) return
      const value = object(raw), delta = object(value.delta)
      const choices = Array.isArray(value.choices) ? value.choices : []
      responseSeen ||= !ctx.global.stream || protocol === 'mock' || value.done === true ||
        value.type === 'message_stop' || value.type === 'response.completed' ||
        value.type === 'message_delta' && typeof delta.stop_reason === 'string' ||
        choices.some(choice => typeof object(choice).finish_reason === 'string')
      usage = extractModelUsage(protocol, raw, usage)
      if (responseSeen && ['unknown', 'cancelled'].includes(attempt.state)) attempt = complete!('completed', true,
        Object.keys(usage).length ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } : undefined)
      parent?.response(raw)
    },
    finish(status) {
      if (!attempt || !['prepared', 'invoking'].includes(attempt.state)) return
      attempt = complete!(status, responseSeen, Object.keys(usage).length
        ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } : undefined)
      parent?.finish(status)
    },
  }
  return { boundary, observation, modelStepId }
}
