import { terminalDelivery, type State } from './state.js'

/** End queue entries, preserving finished history and the truth of unconfirmed physical sends. */
export function closeQQQueues(state: State): void {
  for (const job of state.jobs) {
    if (!['completed', 'failed', 'cancelled'].includes(job.state)) {
      job.state = job.outcome === 'completed' ? 'completed' : 'cancelled'
      job.reason = 'BACKEND_STOPPED'
      job.outcome ??= 'cancelled'
    }
    delete job.nextWaitAt
    delete job.filePreparationPending
  }
  for (const output of state.outbox) {
    if (output.status === 'inflight') output.status = 'unknown'
    else if (output.status === 'pending') output.status = 'failed'
    if (output.sourceScopeId && !output.result && ['unknown', 'failed'].includes(output.status)) {
      output.confirmedAt = Date.now()
      const { eventId, requestId, selfId, conversationType, targetId, seq } = output.frame.data
      output.result = { eventId, requestId, selfId, conversationType, targetId, seq,
        status: output.status as 'unknown' | 'failed', messageIds: [], activity: false, terminal: terminalDelivery(output) }
    }
    delete output.notBefore
  }
  state.windows = {}
  for (const discussion of Object.values(state.discussions)) {
    discussion.active = false
    discussion.summaryPending = false
    if (discussion.maintenance && ['running', 'pending'].includes(discussion.maintenance.status)) {
      discussion.maintenance.status = 'cancelled'
      discussion.maintenance.reason = 'BACKEND_STOPPED'
    }
  }
}
