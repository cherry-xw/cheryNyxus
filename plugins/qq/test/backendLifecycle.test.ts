import { describe, expect, it } from 'vitest'
import { closeQQQueues } from '../src/backendLifecycle.js'
import { emptyState, type State } from '../src/state.js'

describe('QQ Backend shutdown queues', () => {
  it('ends old input and delivery queues without erasing completed history, memory or identity', () => {
    const state = emptyState()
    Object.assign(state, { identityBinding: { selfId: '123' },
      jobs: [{ requestId: 'done', state: 'completed', outcome: 'completed' },
        { requestId: 'queue', state: 'queued', nextWaitAt: 99 }, { requestId: 'active', state: 'running' }],
      outbox: [{ status: 'sent' }, { status: 'pending', notBefore: 99 }, { status: 'inflight' }],
      windows: { old: {} }, discussions: { group: { active: true, summaryPending: true, summary: 'saved memory', messages: [],
        maintenance: { status: 'running' } } } })
    closeQQQueues(state as State)
    expect(state.jobs.map(job => job.state)).toEqual(['completed', 'cancelled', 'cancelled'])
    expect(state.outbox.map(output => output.status)).toEqual(['sent', 'failed', 'unknown'])
    expect(state.windows).toEqual({})
    expect(state.identityBinding).toEqual({ selfId: '123' })
    expect(state.discussions.group).toMatchObject({ active: false, summary: 'saved memory', summaryPending: false, maintenance: { status: 'cancelled' } })
    const once = structuredClone(state)
    closeQQQueues(state)
    expect(state).toEqual(once)
  })
})
