import { describe, expect, it } from 'vitest'
import type { WorkflowOccurrence, WorkflowStepKind } from '@chery/protocol'
import { projectHeaderState } from '../../src/features/agent/workbench/runtime-diagram/headerState'
import { projectHeaderEdgeEvidence } from '../../src/features/agent/workbench/runtime-diagram/headerEdgeEvidence'
import { workflowContinuousPulseTiming, type WorkflowMotionEdge } from '../../src/features/agent/workbench/runtime-diagram/motionPolicy'

function occurrence(id: string, kind: WorkflowStepKind, overrides: Partial<WorkflowOccurrence> = {}): WorkflowOccurrence {
  return { occurrenceId: id, rootChatId: 'root', chatId: 'root', runId: 'run',
    contextStageId: 'stage', kind, label: kind, status: 'succeeded', anchors: [],
    startedAt: 1, updatedAt: 2, firstSequence: 1, lastSequence: 2, orderQuality: 'exact', ...overrides }
}
function project(occurrences: WorkflowOccurrence[]) {
  return projectHeaderEdgeEvidence(projectHeaderState({ chatId: 'root', occurrences, calls: [], recorded: true, complete: true }), occurrences)
}

describe('observed header execution paths', () => {
  it('crosses the structural round entry without inventing an occurrence', () => {
    const result = project([occurrence('queue', 'queue', { runId: undefined }), occurrence('input', 'input', { causeOccurrenceId: 'queue', status: 'running' })])
    expect([...result.keys()]).toEqual(['queue:entry', 'entry:input'])
    expect(result.get('queue:entry')?.targetStatus).toBe('running')
  })

  it('shows response branching when the model and response share one observation', () => {
    const result = project([
      occurrence('model', 'model', { reason: 'response' }),
      occurrence('checkpoint', 'checkpoint', { causeOccurrenceId: 'model' }),
    ])
    expect(result.has('model:response')).toBe(true)
    expect(result.has('response:channels')).toBe(true)
    expect(result.has('channels:checkpoint')).toBe(true)
    expect(result.has('channels:tool-list')).toBe(false)
  })

  it('shows exact context as a parallel request supply without replacing the input cause', () => {
    const result = project([
      occurrence('context', 'context', { iteration: undefined, attempt: undefined }),
      occurrence('input', 'input', { iteration: 1, attempt: 1, firstSequence: 3 }),
      occurrence('request', 'request', {
        iteration: 1,
        attempt: 1,
        firstSequence: 5,
        causeOccurrenceId: 'input',
      }),
    ])
    expect(result.has('input:request')).toBe(true)
    expect(result.has('context:request')).toBe(true)
  })

  it.each(['tool-approval', 'tool-preflight'] as const)('chooses the actual authorization branch to %s', (kind) => {
    const result = project([
      occurrence('auth', 'tool-authorization', { callId: 'call' }),
      occurrence('next', kind, { callId: 'call', causeOccurrenceId: 'auth', status: 'waiting' }),
    ])
    expect(result.has('authorization:approval-needed')).toBe(true)
    expect(result.has(`approval-needed:${kind === 'tool-approval' ? 'approval' : 'preflight'}`)).toBe(true)
    expect(result.has(`approval-needed:${kind === 'tool-approval' ? 'preflight' : 'approval'}`)).toBe(false)
  })

  it('collects a rejected call without lighting its execution path', () => {
    const result = project([
      occurrence('deny', 'tool-approval', { callId: 'call', status: 'rejected' }),
      occurrence('result', 'tool-result', { callId: 'call', causeOccurrenceId: 'deny' }),
    ])
    expect(result.has('approval:rejection')).toBe(true)
    expect(result.has('rejection:tool-result')).toBe(true)
    expect(result.has('approval:preflight')).toBe(false)
  })

  it('crosses from the previous loop decision into the selected iteration', () => {
    const result = project([
      occurrence('decision', 'loop-decision', { iteration: 1 }),
      occurrence('input', 'input', { iteration: 2, causeOccurrenceId: 'decision' }),
    ])
    expect(result.has('decision:entry')).toBe(true)
    expect(result.has('entry:input')).toBe(true)
  })

  it('does not treat unordered steps, missing steps, or other runs as causal evidence', () => {
    expect(project([occurrence('request', 'request'), occurrence('model', 'model')]).size).toBe(0)
    expect(project([occurrence('input', 'input'), occurrence('model', 'model', { causeOccurrenceId: 'input' })]).size).toBe(0)
    expect(project([occurrence('request', 'request', { runId: 'old' }), occurrence('model', 'model', { causeOccurrenceId: 'request' })]).size).toBe(0)
  })

  it('retains an earlier request path when a later request has no model result yet', () => {
    const result = project([
      occurrence('request-1', 'request'),
      occurrence('model', 'model', { causeOccurrenceId: 'request-1' }),
      occurrence('request-2', 'request', { firstSequence: 3, lastSequence: 3 }),
    ])
    expect(result.get('request:model')?.sourceOccurrenceId).toBe('request-1')
  })

  it('uses a shared cycle and consecutive phases through a boundary', () => {
    const first: WorkflowMotionEdge = { id: 'first', sourceId: 'a', targetId: 'pin', family: 'header', evidenced: true,
      sourceOccurrenceId: 'source', targetOccurrenceId: 'target', targetStatus: 'running', sequence: 1,
      points: [{ x: 0, y: 0 }, { x: 80, y: 0 }] }
    const second = { ...first, id: 'second', sourceId: 'pin', targetId: 'b', points: [{ x: 80, y: 0 }, { x: 160, y: 0 }] }
    const a = workflowContinuousPulseTiming(first, [first, second])
    const b = workflowContinuousPulseTiming(second, [first, second])
    expect(a.cycle).toBe(b.cycle)
    expect(a.delay + a.duration).toBeCloseTo(b.delay)
    expect(b.delay + b.duration).toBeCloseTo(b.cycle)
  })

  it('restores the complete ordered text chain without cause fields or response aliases', () => {
    const items = ['input', 'request', 'model', 'checkpoint', 'loop-decision', 'result'].map((kind, index) =>
      occurrence(kind, kind as WorkflowStepKind, { iteration: 1, attempt: 1,
        firstSequence: index * 3 + 1, lastSequence: index * 3 + 2 }))
    const result = project(items)
    for (const id of ['input:request', 'request:model', 'model:response', 'response:channels', 'channels:checkpoint',
      'checkpoint:decision', 'decision:result']) expect(result.has(id), id).toBe(true)
    // A replay snapshot must not borrow future steps from the live run.
    expect([...project(items.slice(0, 3)).keys()]).toEqual(['input:request', 'request:model'])
    expect(items.every(item => !item.causeOccurrenceId)).toBe(true)
  })

  it('restores pre-run intake only through the consumed message anchor', () => {
    const anchors = [{ kind: 'message' as const, id: 'user-message', chatId: 'root' }]
    const result = project([
      occurrence('submission', 'submission', { runId: undefined, anchors }),
      occurrence('queue', 'queue', { runId: undefined, anchors }),
      occurrence('other-queue', 'queue', { runId: undefined, anchors: [] }),
      occurrence('input', 'input', { anchors, firstSequence: 4 }),
    ])
    expect([...result.keys()].sort()).toEqual(['entry:input', 'queue:entry', 'submission:queue'])
    expect(result.get('queue:entry')?.sourceOccurrenceId).toBe('queue')
  })

  it('restores legacy approval routing with interleaved calls and batch notifications', () => {
    const items = [
      occurrence('model', 'model', { firstSequence: 1 }),
      occurrence('validation-a', 'tool-validation', { callId: 'a', batchId: 'batch', firstSequence: 3 }),
      occurrence('list', 'tool-list', { batchId: 'batch', firstSequence: 4 }),
      occurrence('auth-b', 'tool-authorization', { callId: 'b', firstSequence: 5 }),
      occurrence('auth-a', 'tool-authorization', { callId: 'a', firstSequence: 6 }),
      occurrence('approval-a', 'tool-approval', { callId: 'a', firstSequence: 7 }),
      occurrence('preflight-a', 'tool-preflight', { callId: 'a', firstSequence: 8 }),
      occurrence('execution-a', 'tool-execution', { callId: 'a', firstSequence: 9 }),
      occurrence('result-a', 'tool-result', { callId: 'a', firstSequence: 10 }),
      occurrence('checkpoint-a', 'checkpoint', { callId: 'a', firstSequence: 11 }),
    ]
    const result = project(items)
    for (const id of ['model:response', 'response:channels', 'channels:tool-list', 'tool-list:validation',
      'validation:authorization', 'authorization:approval-needed', 'approval-needed:approval',
      'approval:preflight', 'preflight:execution', 'execution:tool-result', 'tool-result:checkpoint'])
      expect(result.has(id), id).toBe(true)
    expect(result.get('validation:authorization')?.targetOccurrenceId).toBe('auth-a')
    expect(result.has('approval-needed:preflight')).toBe(false)
  })

  it('keeps legacy retries and loop transitions scoped and retains earlier paths', () => {
    const items = [
      occurrence('input', 'input', { iteration: 1, firstSequence: 1 }),
      occurrence('request-1', 'request', { iteration: 1, attempt: 1, firstSequence: 2 }),
      occurrence('model-1', 'model', { iteration: 1, attempt: 1, firstSequence: 3, status: 'failed' }),
      occurrence('retry', 'retry', { iteration: 1, attempt: 1, firstSequence: 4 }),
      occurrence('request-2', 'request', { iteration: 1, attempt: 2, firstSequence: 5 }),
      occurrence('model-2', 'model', { iteration: 1, attempt: 2, firstSequence: 6 }),
      occurrence('checkpoint', 'checkpoint', { iteration: 1, attempt: 2, firstSequence: 7 }),
      occurrence('decision', 'loop-decision', { iteration: 1, firstSequence: 8 }),
      occurrence('input-2', 'input', { iteration: 2, firstSequence: 9 }),
    ]
    const result = project(items)
    for (const id of ['input:request', 'request:model', 'model:error', 'error:retry',
      'retry:request', 'response:channels', 'channels:checkpoint', 'checkpoint:decision', 'decision:entry', 'entry:input'])
      expect(result.has(id), id).toBe(true)
    expect(result.get('retry:request')?.targetOccurrenceId).toBe('request-2')
  })

  it('never replaces explicit causes or connects unrelated legacy identities', () => {
    const request = occurrence('request', 'request', { iteration: 1, attempt: 1, firstSequence: 1 })
    const model = occurrence('model', 'model', { iteration: 1, attempt: 1, firstSequence: 4 })
    for (const overrides of [{ runId: 'other' }, { chatId: 'other' }, { iteration: 2 },
      { attempt: 2 }, { orderQuality: 'reconstructed' as const }, { causeOccurrenceId: 'missing' }])
      expect(project([request, { ...model, ...overrides }]).has('request:model')).toBe(false)
    expect(project([request, { ...request, occurrenceId: 'tie' }, model]).has('request:model')).toBe(false)
    expect(project([
      occurrence('preflight-a', 'tool-preflight', { callId: 'a', firstSequence: 1 }),
      occurrence('execution-b', 'tool-execution', { callId: 'b', firstSequence: 3 }),
    ]).has('preflight:execution')).toBe(false)
  })

  it('retains the whole run trace after advancing rounds, but respects explicit replay selection', () => {
    const items = [
      occurrence('input-1', 'input', { iteration: 1 }),
      occurrence('request-1', 'request', { iteration: 1, causeOccurrenceId: 'input-1' }),
      occurrence('model-1', 'model', { iteration: 1, causeOccurrenceId: 'request-1', reason: 'response' }),
      occurrence('checkpoint-1', 'checkpoint', { iteration: 1, causeOccurrenceId: 'model-1' }),
      occurrence('decision-1', 'loop-decision', { iteration: 1, causeOccurrenceId: 'checkpoint-1' }),
      occurrence('input-2', 'input', { iteration: 2, causeOccurrenceId: 'decision-1', status: 'running' }),
    ]
    const result = project(items)
    for (const id of ['input:request', 'request:model', 'model:response', 'response:channels', 'channels:checkpoint',
      'checkpoint:decision', 'decision:entry', 'entry:input']) expect(result.has(id), id).toBe(true)
    const historical = projectHeaderState({ chatId: 'root', occurrences: items, calls: [], recorded: true,
      complete: true, selection: { iteration: 1 } })
    expect(projectHeaderEdgeEvidence(historical, items).has('decision:entry')).toBe(false)
  })

  it('keeps explicitly consumed intake from before the run, without importing other old work', () => {
    const result = project([
      occurrence('submission', 'submission', { runId: undefined }),
      occurrence('queue', 'queue', { runId: undefined, causeOccurrenceId: 'submission' }),
      occurrence('input', 'input', { causeOccurrenceId: 'queue', status: 'running' }),
    ])
    expect([...result.keys()].sort()).toEqual(['entry:input', 'queue:entry', 'submission:queue'])
  })

  it('selects the failure collector instead of rejecting both possible execution-result routes', () => {
    const result = project([
      occurrence('execution', 'tool-execution', { callId: 'a', status: 'rejected' }),
      occurrence('result', 'tool-result', { callId: 'a', causeOccurrenceId: 'execution' }),
    ])
    expect(result.has('execution:rejection')).toBe(true)
    expect(result.has('rejection:tool-result')).toBe(true)
    expect(result.has('execution:tool-result')).toBe(false)
  })
})
