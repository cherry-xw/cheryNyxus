import type { WorkflowOccurrence, WorkflowStepKind } from '@chery/protocol'

/** Compatibility for ordered journal steps recorded before causal links were written.
 * This is a display projection, never a journal repair or arbitrary adjacency link.
 */
export function legacyHeaderPredecessor(
  target: WorkflowOccurrence,
  history: readonly WorkflowOccurrence[],
): WorkflowOccurrence | undefined {
  if (target.causeOccurrenceId || target.orderQuality !== 'exact') return
  if (target.kind === 'input' || target.kind === 'queue') {
    const kind = target.kind === 'input' ? 'queue' : 'submission'
    const intake = history.filter(item => item.kind === kind && item.orderQuality === 'exact' &&
      item.chatId === target.chatId && item.rootChatId === target.rootChatId &&
      (!item.runId || item.runId === target.runId) && target.anchors.some(anchor =>
        anchor.kind === 'message' && item.anchors.some(other => other.kind === 'message' &&
          other.id === anchor.id && (!other.chatId || other.chatId === target.chatId))))
    if (intake.length === 1) return intake[0]
  }
  if (!target.runId) return
  const scope = history.filter(item => item.occurrenceId !== target.occurrenceId &&
    item.orderQuality === 'exact' && item.chatId === target.chatId &&
    item.rootChatId === target.rootChatId && item.runId === target.runId)
  const round = scope.filter(item => item.iteration === target.iteration)
  const attempt = round.filter(item => item.attempt === target.attempt)
  const before = (items: WorkflowOccurrence[]) => items.filter(item => item.firstSequence < target.firstSequence)
  // Prefer the closest eligible phase, but never resolve tied sequences by array order.
  function latest(items: WorkflowOccurrence[], kinds: WorkflowStepKind[]): WorkflowOccurrence | undefined {
    const candidates = before(items).filter(item => kinds.includes(item.kind))
      .sort((a, b) => b.firstSequence - a.firstSequence)
    return candidates[0]?.firstSequence === candidates[1]?.firstSequence ? undefined : candidates[0]
  }
  const call = attempt.filter(item => !!target.callId && item.callId === target.callId &&
    (!target.batchId || !item.batchId || item.batchId === target.batchId))
  switch (target.kind) {
    case 'input':
      return target.iteration === undefined ? undefined : latest(scope.filter(item =>
        item.iteration === target.iteration! - 1), ['loop-decision'])
    case 'command': return latest(round, ['input'])
    case 'request':
      return latest(round.filter(item => item.kind === 'input' || item.kind === 'command' ||
        (item.kind === 'retry' && (item.attempt ?? 0) === (target.attempt ?? 0) - 1) ||
        (item.kind === 'compact-applied' && item.attempt === target.attempt)),
      ['input', 'command', 'retry', 'compact-applied']) ?? latest(attempt, ['context'])
    case 'model': return latest(attempt, ['request'])
    case 'retry': return latest(attempt, ['model'])
    case 'tool-list': return latest(attempt, ['model'])
    case 'tool-validation': {
      if (!target.callId) return
      // Some old recorders emitted validation before the final batch notification.
      // A shared batch identity is stronger than notification order in that case.
      const batches = attempt.filter(item => item.kind === 'tool-list' &&
        ((!!target.batchId && item.batchId === target.batchId) ||
          item.anchors.some(anchor => anchor.kind === 'tool-call' && anchor.id === target.callId)))
      return batches.length === 1 ? batches[0] : undefined
    }
    case 'tool-authorization': return latest(call, ['tool-validation'])
    case 'tool-approval': return latest(call, ['tool-authorization'])
    case 'tool-preflight': return latest(call, ['tool-approval', 'tool-authorization'])
    case 'tool-execution': return latest(call, ['tool-preflight'])
    case 'tool-result': return latest(call, ['tool-execution', 'tool-preflight', 'tool-approval',
      'tool-authorization', 'tool-validation'])
    case 'checkpoint': {
      const results = before(attempt).filter(item => item.kind === 'tool-result' &&
        (target.callId ? item.callId === target.callId : target.anchors.some(anchor =>
          item.anchors.some(other => anchor.kind === other.kind && anchor.id === other.id))))
      if (results.length === 1) return results[0]
      if (target.callId || results.length) return
      return latest(attempt, ['model'])
    }
    case 'loop-decision': return latest(round, ['checkpoint'])
    case 'result': return latest(round, ['loop-decision', 'model'])
    case 'compact-request': return latest(attempt, ['request'])
    case 'compact-summary': return latest(round, ['compact-request'])
    case 'compact-applied': return latest(round, ['compact-summary'])
    default: return
  }
}
