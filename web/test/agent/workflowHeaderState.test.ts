import { describe, expect, it } from 'vitest'
import type { WorkflowOccurrence } from '@chery/protocol'
import { projectHeaderState } from '../../src/features/agent/workbench/runtime-diagram/headerState'

function occurrence(
  id: string,
  kind: WorkflowOccurrence['kind'],
  overrides: Partial<WorkflowOccurrence> = {},
): WorkflowOccurrence {
  return {
    occurrenceId: id,
    kind,
    rootChatId: 'root',
    chatId: 'root',
    contextStageId: 'stage',
    runId: 'run-1',
    iteration: 1,
    attempt: 0,
    label: kind,
    status: 'succeeded',
    anchors: [],
    startedAt: 1,
    updatedAt: 2,
    firstSequence: 1,
    lastSequence: 2,
    orderQuality: 'exact',
    ...overrides,
  }
}
function state(
  occurrences: WorkflowOccurrence[],
  overrides: Partial<Parameters<typeof projectHeaderState>[0]> = {},
) {
  return projectHeaderState({
    chatId: 'root',
    occurrences,
    calls: [],
    recorded: true,
    complete: true,
    ...overrides,
  })
}

describe('header instance state', () => {
  it('keeps runless receive/wake evidence accessible without assigning it to a nearby run', () => {
    const facts = [
      occurrence('model', 'model'),
      occurrence('receive', 'parent-receive', {
        runId: undefined,
        iteration: undefined,
        attempt: undefined,
        firstSequence: 3,
      }),
    ]
    expect(state(facts).slots['parent-receive']?.status).toBe('idle')
    const runless = state(facts, { selection: { unassignedRun: true } })
    expect(runless.hasUnassignedRun).toBe(true)
    expect(runless.slots['parent-receive']?.status).toBe('succeeded')
    expect(runless.slots.model?.status).toBe('idle')
    expect(runless.slots.wake?.status).toBe('idle')
  })
  it('lists every explicitly anchored batch call without inventing execution evidence', () => {
    const calls = ['a', 'b'].map((id) => ({
      id,
      name: '同名工具',
      status: 'completed',
      batchId: 'batch-1',
    }))
    const projected = state([occurrence('list', 'tool-list', { batchId: 'batch-1' })], { calls })
    expect(projected.calls.map((call) => call.id)).toEqual(['a', 'b'])
    expect(projected.slots.execution?.status).toBe('idle')
    expect(state([], { calls, currentRunId: 'next-run' }).calls).toEqual([])
  })
  it('retains terminal slots until the next run or iteration and allows explicit history selection', () => {
    const done = occurrence('request-1', 'request')
    expect(state([done]).slots.request?.status).toBe('succeeded')
    expect(state([done], { currentRunId: 'run-2' }).slots.request?.status).toBe('idle')
    const next = occurrence('model-2', 'model', {
      iteration: 2,
      status: 'running',
      firstSequence: 3,
    })
    expect(state([done, next]).slots.request?.status).toBe('idle')
    expect(
      state([done, next], { selection: { runId: 'run-1', iteration: 1 } }).slots.request?.occurrence
        ?.occurrenceId,
    ).toBe('request-1')
    expect(
      state([done], { currentRunId: 'run-2', selection: { runId: 'run-1' } }).slots.request?.status,
    ).toBe('succeeded')
  })

  it('separates attempts without replaying run-level context or overwriting failed attempts', () => {
    const facts = [
      occurrence('context', 'context', { iteration: undefined, attempt: undefined }),
      occurrence('failed', 'model', { status: 'failed' }),
      occurrence('retry', 'retry', { status: 'waiting', waitReason: 'retry' }),
      occurrence('next', 'model', { attempt: 1, firstSequence: 3 }),
    ]
    expect(state(facts).slots.model?.status).toBe('succeeded')
    expect(state(facts).slots.context?.occurrence?.occurrenceId).toBe('context')
    const previous = state(facts, { selection: { attempt: 0 } })
    expect(previous.slots.model?.status).toBe('failed')
    expect(previous.slots.retry?.statusText).toBe('等待重试')
    expect(facts[1]?.status).toBe('failed')
  })

  it('isolates same-name calls, preserves browsing through live updates and returns to the current call', () => {
    const facts = [
      occurrence('a-validation', 'tool-validation', { callId: 'a' }),
      occurrence('a-approval', 'tool-approval', {
        callId: 'a',
        status: 'rejected',
        lastSequence: 4,
      }),
      occurrence('b-execution', 'tool-execution', {
        callId: 'b',
        status: 'running',
        firstSequence: 5,
        lastSequence: 6,
      }),
      occurrence('foreign', 'tool-execution', {
        callId: 'a',
        chatId: 'child',
        status: 'running',
        lastSequence: 100,
      }),
    ]
    const calls = ['a', 'b'].map((id) => ({ id, name: '同名工具', status: 'completed' }))
    const browsing = state(facts, { calls, selection: { callId: 'a' } })
    expect(browsing.selectedCallId).toBe('a')
    expect(browsing.currentCallId).toBe('b')
    expect(browsing.slots.approval?.status).toBe('rejected')
    expect(browsing.slots.rejection?.status).toBe('rejected')
    expect(browsing.slots.preflight?.status).toBe('idle')
    expect(browsing.slots.execution?.status).toBe('idle')
    expect(browsing.calls.map((call) => call.ordinal)).toEqual([1, 2])
    const live = state(
      [...facts, occurrence('b-result', 'tool-result', { callId: 'b', firstSequence: 7 })],
      { calls, selection: browsing.selection },
    )
    expect(live.selectedCallId).toBe('a')
    expect(state(facts, { calls }).slots.execution?.occurrence?.callId).toBe('b')
    expect(
      state(facts, { calls, currentRunId: 'run-2', selection: browsing.selection }).slots.approval
        ?.status,
    ).toBe('idle')
  })

  it('never equates child return with parent receive, wait or wake', () => {
    const result = state([occurrence('child-return', 'child-return')])
    expect(result.slots['child-return']?.status).toBe('succeeded')
    expect(result.slots['parent-receive']?.status).toBe('idle')
    expect(result.slots.wait?.status).toBe('idle')
    expect(result.slots.wake?.status).toBe('idle')
  })

  it('distinguishes unknown, unobserved and not-started without reconstructing old successes', () => {
    expect(state([], { recorded: false }).slots.request?.status).toBe('unknown')
    expect(state([], { complete: false }).slots.request?.status).toBe('unknown')
    expect(state([]).slots.request?.status).toBe('idle')
    expect(
      state([occurrence('legacy', 'model', { orderQuality: 'reconstructed' })]).slots.model?.status,
    ).toBe('unknown')
    expect(state([occurrence('context', 'context')]).slots.channels?.status).toBe('unrecorded')
    expect(
      state([occurrence('authorization', 'tool-authorization', { callId: 'a' })]).slots[
        'approval-needed'
      ]?.status,
    ).toBe('unrecorded')
  })

  it('matches response and wait only from structured evidence, not labels', () => {
    expect(
      state([occurrence('model', 'model', { label: '处理响应' })]).slots.response?.status,
    ).toBe('idle')
    expect(
      state([occurrence('model', 'model', { reason: 'response', status: 'running' })]).slots
        .response?.status,
    ).toBe('running')
    expect(
      state([occurrence('wait', 'loop-decision', { status: 'waiting', waitReason: 'child' })]).slots
        .wait?.statusText,
    ).toBe('等待子任务')
  })
})
