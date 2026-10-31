import { randomUUID } from 'node:crypto'
import type { MiddlewareContext } from '@/core/middleware/types.js'
import type { LLMOptions } from '@/core/llm/adapter.js'
import type { PreparedSourceHistory } from './sourceHistory.js'
import { sourceContextError } from '@/db/sourceContext.js'

/** Uses the existing QQ memory/summary prerequisite, never a member's tool authority. */
export async function prepareSourceCapacity(ctx: MiddlewareContext, source: PreparedSourceHistory, options: LLMOptions): Promise<string> {
  options.signal?.throwIfAborted()
  source.authority.validate()
  const maintain = ctx.requestExecution?.sourceCapacity
  if (!maintain) sourceContextError('SOURCE_CONTEXT_UNAVAILABLE')
  const { repo, authority, input, snapshot } = source
  const maintenance = repo.maintenanceAuthority(authority, input.scopeId)
  const operationId = `capacity-${randomUUID()}`
  const prepared = repo.prepareMaintenanceSummary(maintenance, input.scopeId, { operationId, purpose: 'capacity',
    qqConfigRevision: snapshot.qqConfigRevision, parentSnapshotId: snapshot.snapshotId })
  if (!prepared.operation.evidence.some(evidence => evidence.textPartIds.length)) {
    repo.updateSummaryProgress(maintenance, input.scopeId, { operationId, expectedVersion: prepared.operation.version,
      status: 'failed', phase: 'history', reasonCode: 'SUMMARY_BUDGET_FAILED' })
    sourceContextError('SUMMARY_BUDGET_FAILED')
  }
  await maintain({ operationId, parentSnapshotId: snapshot.snapshotId }, options.signal)
  options.signal?.throwIfAborted()
  authority.validate()
  const child = repo.capacitySnapshot(authority, input.scopeId, snapshot.snapshotId, operationId)
  // This in-memory execution handle is already authorized; saved source references grant nothing.
  ctx.requestExecution!.sourceInput = { ...input, snapshotId: child.snapshotId }
  return operationId
}

export function failSourceCapacity(source: PreparedSourceHistory, operationId: string, signal?: AbortSignal): void {
  try {
    const maintenance = source.repo.maintenanceAuthority(source.authority, source.input.scopeId)
    const current = source.repo.summaryStatus(maintenance, source.input.scopeId, operationId)
    if (current.status !== 'completed' && current.status !== 'cancelled') {
      source.repo.updateSummaryProgress(maintenance, source.input.scopeId, {
        operationId, expectedVersion: current.version, status: signal?.aborted ? 'cancelled' : 'failed',
        phase: current.phase, reasonCode: signal?.aborted ? 'SUMMARY_FOREGROUND_PRIORITY' : 'SUMMARY_BUDGET_FAILED',
      })
    }
  } catch { /* Never mask the underlying admission failure. */ }
}
