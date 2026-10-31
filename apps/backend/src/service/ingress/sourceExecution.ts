import { SourceInputSchema, type SourceInput } from '@chery/protocol'
import { SourceContextRepository, sourceContextError, type SourceAuthority } from '@/db/sourceContext.js'
import { getSoulDb } from '@/db/index.js'
import type { IngressRequestIdentity } from './api.js'
import type { ingressExecution } from './request.js'

/** Only an in-process execution handle can authorize a source projection. Saved rows are not handles. */
export function sourceExecutionAuthority(identity: Readonly<IngressRequestIdentity> | undefined, validate: (() => void) | undefined): SourceAuthority {
  const subject = identity?.subject
  if (!validate || identity?.source !== 'plugin' || !identity.ownerId || !identity.channel || !subject) sourceContextError('IDENTITY_REJECTED')
  validate()
  return { ownerId: identity.ownerId, channel: identity.channel, selfId: subject.selfId,
    conversationType: subject.conversationType, targetId: subject.conversationType === 'group' ? subject.groupId! : subject.userId,
    actorId: subject.userId, purpose: 'execution', validate }
}
export function validateSourceInput(value: SourceInput, authority: SourceAuthority) {
  const input = SourceInputSchema.parse(value), repo = new SourceContextRepository(getSoulDb())
  const snapshot = repo.snapshot(authority, input.scopeId, input.snapshotId)
  if (snapshot.requestId !== input.requestId || JSON.stringify(snapshot.actorRecord) !== JSON.stringify(input.actorRecord) ||
    JSON.stringify(snapshot.inputRecords) !== JSON.stringify(input.inputRecords) || input.turnId !== (snapshot.turnId ?? snapshot.requestId) ||
    repo.read(authority, input.scopeId, [input.actorRecord])[0]?.sender.id !== authority.actorId) sourceContextError('IDENTITY_REJECTED')
  return { input, snapshot, repo }
}

/** New QQ input is not permission to resume a parked tool or question. */
export function isNewQQSourceInput(execution: ReturnType<typeof ingressExecution.getStore>, chatId: string, epochId: string | null | undefined, commandId: string): boolean {
  if (execution?.identity.source !== 'plugin' || execution.identity.ownerId !== 'cherynyxus-qq-module' ||
    execution.identity.entryId !== 'qq' || execution.identity.channel !== 'qq' ||
    execution.execution?.toolHistory !== 'request' || execution.execution.retry !== 'never' || !execution.sourceInput) return false
  execution.signal?.throwIfAborted()
  const authority = sourceExecutionAuthority(execution.identity, execution.validate)
  const { input, snapshot, repo } = validateSourceInput(execution.sourceInput, authority)
  const binding = repo.scope(authority, input.scopeId).coreBinding
  if (input.requestId !== commandId || input.turnId !== commandId || snapshot.turnId !== commandId ||
    snapshot.parentSnapshotId || snapshot.maintenancePurpose || !epochId ||
    binding?.chatId !== chatId || binding.epochId !== epochId) sourceContextError('IDENTITY_REJECTED')
  return true
}
