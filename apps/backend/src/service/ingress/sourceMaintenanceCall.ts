import { randomUUID } from 'node:crypto'
import type { InputTokenPreflight, LLMOptions } from '@/core/llm/adapter.js'
import type { SourceAttempt, SourceDataRef, SourceManifestItem } from '@chery/protocol'
import { inputOrigins } from '@/core/message/inputOrigins.js'
import { extractModelUsage } from '@/agent/provider/usage.js'
import { SourceContextRepository, sourceContextError, sourceFingerprint, type SourceAuthority } from '@/db/sourceContext.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Text-only maintenance has its own input and no user adoption or business tools. */
export function sourceMaintenanceCall(repo: SourceContextRepository, authority: SourceAuthority, input: {
  scopeId: string; operationId: string; contentMessageId: string; content: string
  runtimeConfigRevision: string; registryVersion: number; signal?: AbortSignal
}): Pick<LLMOptions, 'sourceCall' | 'observation'> {
  const check = () => {
    input.signal?.throwIfAborted()
    const scope = repo.scope(authority, input.scopeId, ['maintenance'])
    const current = repo.summaryStatus(authority, input.scopeId, input.operationId)
    if (!['pending', 'running'].includes(current.status) || current.permissionRevision !== scope.permissionRevision ||
      current.baseSelectionRevision !== scope.selectionRevision) sourceContextError('SUMMARY_CONFLICT')
  }
  check()
  const operation = repo.summaryStatus(authority, input.scopeId, input.operationId)
  const snapshot = repo.snapshot(authority, input.scopeId, operation.snapshotId)
  if (snapshot.maintenancePurpose !== operation.purpose || snapshot.requestId !== input.operationId || !['pending', 'running'].includes(operation.status)) sourceContextError('PERMISSION_DENIED')
  const modelStepId = `maintenance-step-${randomUUID()}`
  let attempt: SourceAttempt | undefined, complete: ReturnType<SourceContextRepository['attemptCompletion']> | undefined
  let budget: InputTokenPreflight | undefined, responseSeen = false, usage: SourceAttempt['usage'], protocol = ''
  return {
    sourceCall: {
      budget(value) { budget = value },
      prepare(body, wireProtocol) {
        check()
        if (attempt?.state === 'invoking') sourceContextError('SOURCE_CONFLICT')
        if (attempt?.state === 'prepared') attempt = complete!('failed', false, undefined)
        protocol = wireProtocol
        const result = repo.db.transaction(() => {
          if (Array.isArray(body.tools) && body.tools.length || Array.isArray(body.functions) && body.functions.length) sourceContextError('PERMISSION_DENIED')
          const dataId = `maintenance-data-${randomUUID()}`
          // Maintenance may contain existing group memory. This aggregate is never public prompt text.
          const data: SourceDataRef = { dataId, revision: 1, kind: 'memory', provenance: { kind: 'memory', entryId: dataId, entryRevision: 1 } }
          const manifest: SourceManifestItem[] = [], messages = body.input ?? body.messages
          if (!Array.isArray(messages)) sourceContextError('SOURCE_INPUT_MAPPING_UNAVAILABLE')
          for (const [messageIndex, message] of messages.entries()) {
            const raw = object(message), blocks = Array.isArray(raw.content) ? raw.content : [message]
            for (const [blockIndex, block] of blocks.entries()) {
              if (!inputOrigins(block).some(origin => origin.messageId === input.contentMessageId)) continue
              const value = object(block), text = typeof value.text === 'string' ? value.text : typeof value.content === 'string' ? value.content : undefined
              if (text === undefined) sourceContextError('SOURCE_INPUT_MAPPING_UNAVAILABLE')
              manifest.push({ itemId: `maintenance-item-${randomUUID()}`, sourceRef: { kind: 'data', data }, position: { messageIndex, blockIndex },
                representation: 'text', renderedTextRef: repo.saveRenderedText(authority, input.scopeId, text) })
            }
          }
          if (!manifest.length) sourceContextError('SOURCE_INPUT_MAPPING_UNAVAILABLE')
          repo.saveDataSnapshot(authority, input.scopeId, data, input.content)
          const projection = repo.saveProjection(authority, input.scopeId, { projectionId: `maintenance-projection-${randomUUID()}`, modelStepId,
            snapshotId: snapshot.snapshotId, runtimeConfigRevision: input.runtimeConfigRevision, registryVersion: input.registryVersion,
            model: String(body.model), protocol, toolNames: [], fileInputs: [], toolHistoryRefs: [], executionFactRefs: [], dataContextRefs: [data],
            orderedInputManifest: manifest, contentFingerprint: sourceFingerprint(body),
            ...(budget ? { budgetSnapshotId: repo.savePreparationResult(authority, input.scopeId, 'budget', budget) } : {}) }, 'initial')
          const prepared = repo.prepareAttempt(authority, input.scopeId, projection.projectionId, `maintenance-attempt-${randomUUID()}`)
          return { attempt: prepared, complete: repo.attemptCompletion(authority, input.scopeId, prepared.attemptId) }
        })()
        attempt = result.attempt; complete = result.complete; responseSeen = false; usage = undefined
      },
    },
    observation: {
      start() {
        check()
        if (!attempt) sourceContextError('SOURCE_INPUT_MAPPING_UNAVAILABLE')
        if (attempt.state === 'invoking') return
        attempt = repo.invokeMaintenanceAttempt(authority, input.scopeId, attempt.attemptId)
      },
      response(value) {
        if (!attempt?.startedAt || !['invoking', 'unknown', 'cancelled'].includes(attempt.state)) return
        responseSeen = true
        const measured = extractModelUsage(protocol, value, {})
        usage = Object.keys(measured).length ? { inputTokens: measured.inputTokens, outputTokens: measured.outputTokens, totalTokens: measured.totalTokens } : undefined
        if (['unknown', 'cancelled'].includes(attempt.state)) attempt = complete!('completed', true, usage)
      },
      finish(status) {
        if (attempt && ['prepared', 'invoking'].includes(attempt.state)) attempt = complete!(status, responseSeen, usage)
      },
    },
  }
}
