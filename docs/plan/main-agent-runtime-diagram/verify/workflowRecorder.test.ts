// Isolated recorder checks. Every persistence and identity dependency is mocked in memory.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowJournalEventInput } from '@/db/workflowJournal.js'

type RecordedGap = {
  rootChatId: string
  chatId?: string
  runId?: string
  contextStageId?: string
  reason: string
}

const fixture = vi.hoisted(() => ({
  appendCalls: [] as WorkflowJournalEventInput[][],
  gaps: [] as RecordedGap[],
  appendFailures: 0,
  identityFailure: false,
}))

vi.mock('@/db/chat.js', () => ({
  getMessages: () => [],
  getRootChatId: (chatId: string) => {
    if (fixture.identityFailure) throw new Error('identity unavailable')
    return chatId === 'grandchild' ? 'branch-root' : chatId
  },
}))
vi.mock('@/db/conversationBranch.js', () => ({
  getConversationBranchByChat: (chatId: string) =>
    chatId === 'branch-root' ? { branchId: 'branch', taskId: 'task' } : undefined,
  getConversationTask: (taskId: string) =>
    taskId === 'task' ? { taskId, originalChatId: 'root' } : undefined,
}))
vi.mock('@/db/workflowJournal.js', () => ({
  appendWorkflowJournalEvents: (events: WorkflowJournalEventInput[]) => {
    if (fixture.appendFailures > 0) {
      fixture.appendFailures--
      throw new Error('journal unavailable')
    }
    fixture.appendCalls.push(structuredClone(events))
  },
  recordWorkflowJournalGap: (gap: RecordedGap) => fixture.gaps.push(structuredClone(gap)),
  readWorkflowStepSnapshot: () => ({ active: [] }),
}))
vi.mock('@/db/delivery.js', () => ({ getSpawnTaskByChild: () => undefined }))
vi.mock('@/service/chat/runtime.js', () => ({ getActiveChatRunId: () => 'run' }))

import { hasWorkflowObserver, reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { startWorkflowRunRecorder } from '@/service/chat/workflowRecorder.js'
import { installWorkflowSnapshot } from '../../../../web/src/features/agent/workbench/runtime-diagram/workflowState'
import { projectHeaderState } from '../../../../web/src/features/agent/workbench/runtime-diagram/headerState'
import { projectHeaderEdgeEvidence } from '../../../../web/src/features/agent/workbench/runtime-diagram/headerEdgeEvidence'
import { buildHeaderNodes } from '../../../../web/src/features/agent/workbench/runtime-diagram/headerGraph'
import type { WorkflowStepEvent } from '@chery/protocol'

function recordedGraph(callId?: string, omitCauses = false) {
  const seen = new Set<string>()
  const events = fixture.appendCalls
    .flat()
    .filter((event) => {
      if (seen.has(event.sourceKey)) return false
      seen.add(event.sourceKey)
      return true
    })
    .map((event, i) => ({
      ...event,
      causeOccurrenceId: omitCauses ? undefined : event.causeOccurrenceId,
      eventId: event.sourceKey,
      sequence: i + 1,
      revision: i + 1,
      at: i + 1,
      orderQuality: 'exact',
    })) as WorkflowStepEvent[]
  const client = installWorkflowSnapshot({
    rootChatId: 'root',
    revision: events.length,
    upperSequence: events.length,
    active: [],
    recentEvents: events,
    gaps: [],
    hasEarlier: false,
    historyComplete: true,
  })
  const occurrences = Object.values(client.occurrences)
  const state = projectHeaderState({
    chatId: 'root',
    occurrences,
    calls: [],
    selection: { callId },
    recorded: true,
    complete: true,
  })
  const graph = buildHeaderNodes({
    header: {
      id: 'header:root',
      laneId: 'root',
      chatId: 'root',
      title: 'root',
      mode: 'full',
      templateVersion: 4,
      runStatus: 'running',
      sections: [],
      calls: [],
      currentIteration: state.scope.iteration ?? 1,
      iterationCount: state.iterations.length,
      steps: occurrences.map((occurrence) => ({
        id: `header-step:${occurrence.occurrenceId}`,
        occurrenceId: occurrence.occurrenceId,
        occurrence,
        laneId: 'root',
        statusText: occurrence.status,
        live: true,
        iteration: occurrence.iteration ?? 1,
        iterationCount: state.iterations.length,
      })),
    },
    position: { x: 0, y: 0 },
    selection: { callId },
    recorded: true,
    complete: true,
    view: { follow: true },
  })
  return { occurrences, state, graph, evidence: projectHeaderEdgeEvidence(state, occurrences) }
}

function beginRound() {
  const recorder = startWorkflowRunRecorder('root')
  reportWorkflow('root', { newIteration: true, iteration: 1 })
  reportWorkflow('root', { activeNodeId: 'input' })
  recorder.recordCommittedMessage({ id: 'user-message', inputId: 'user-input', role: 'user' })
  reportWorkflow('root', { attempt: 1 })
  reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '准备请求' })
  reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '调用中' })
  reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '处理响应' })
  return recorder
}

function validateCall(recorder: ReturnType<typeof startWorkflowRunRecorder>, id: string) {
  recorder.recordChunk({
    type: 'sense_end',
    id,
    name: 'read_file',
    arguments: '{}',
    supervisionLevel: 0,
    security: {
      decision: 'allow',
      roleType: 'assistant',
      policyHash: 'policy',
      findings: [],
      assessmentHash: 'assessment',
    },
  })
}

describe('real recorder -> reducer -> nested execution paths', () => {
  it.each([false, true])(
    'lights the complete text round and every segment (omit causes: %s)',
    (omitCauses) => {
      const recorder = beginRound()
      recorder.recordCommittedMessage({ id: 'answer', role: 'assistant' })
      reportWorkflow('root', { activeNodeId: 'checkpoint' })
      recorder.recordCommittedMessage({ id: 'answer', role: 'assistant' })
      reportWorkflow('root', { activeNodeId: 'decision' })
      reportWorkflow('root', { activeNodeId: 'result', status: 'completed' })
      recorder.finish('succeeded')
      const { graph, occurrences, evidence } = recordedGraph(undefined, omitCauses)
      expect(occurrences.filter((o) => o.kind === 'model')).toHaveLength(1)
      for (const id of [
        'submission:queue',
        'queue:entry',
        'entry:input',
        'context:request',
        'input:request',
        'request:model',
        'model:response',
        'response:channels',
        'channels:checkpoint',
        'checkpoint:decision',
        'decision:result',
      ]) {
        expect(evidence.has(id), id).toBe(true)
        const segments = graph.edges.filter((e) =>
          e.data?.members?.some((m) => m.id === `header:root:edge:${id}`),
        )
        expect(segments.length, id).toBeGreaterThan(0)
        expect(
          segments.every((e) => e.data?.evidenced),
          id,
        ).toBe(true)
      }
      expect(
        graph.edges.filter((e) =>
          e.data?.members?.some((m) => m.id === 'header:root:edge:input:request'),
        ).length,
      ).toBeGreaterThan(1)
    },
  )

  it('links early validation to the final batch and keeps interleaved calls isolated', () => {
    const recorder = beginRound()
    validateCall(recorder, 'a')
    validateCall(recorder, 'b')
    recorder.recordCommittedMessage({ id: 'a', role: 'sense' })
    expect(recordedGraph('a').occurrences.some((o) => o.kind === 'tool-result')).toBe(false)
    recorder.recordChunk({
      type: 'sense_pending',
      approvalId: 'a',
      senseName: 'read_file',
      arguments: '{}',
      supervisionLevel: 0,
    })
    reportWorkflow('root', {
      activeNodeId: 'tools',
      batch: {
        id: 'batch',
        complete: true,
        calls: [
          { id: 'a', name: 'read_file', status: 'pending' },
          { id: 'b', name: 'read_file', status: 'pending' },
        ],
      },
    })
    const pending = recordedGraph('a')
    for (const id of [
      'response:channels',
      'channels:tool-list',
      'tool-list:validation',
      'validation:authorization',
      'authorization:approval-needed',
      'approval-needed:approval',
    ])
      expect(pending.evidence.has(id), id).toBe(true)
    recorder.recordChunk({
      type: 'sense_started',
      id: 'b',
      name: 'read_file',
      arguments: '{}',
      startedAt: 1,
    })
    recorder.recordChunk({ type: 'sense_accept', id: 'b', name: 'read_file', result: 'ok' })
    recorder.recordChunk({
      type: 'sense_started',
      id: 'a',
      name: 'read_file',
      arguments: '{}',
      startedAt: 1,
    })
    recorder.recordChunk({ type: 'sense_accept', id: 'a', name: 'read_file', result: 'ok' })
    recorder.recordCommittedMessage({ id: 'a', role: 'sense' })
    recorder.finish('succeeded')
    const a = recordedGraph('a'),
      b = recordedGraph('b')
    for (const id of [
      'approval:preflight',
      'preflight:execution',
      'execution:tool-result',
      'tool-result:checkpoint',
    ])
      expect(a.evidence.has(id), id).toBe(true)
    expect(b.evidence.has('approval:preflight')).toBe(false)
    expect(b.evidence.has('approval-needed:preflight')).toBe(true)
    expect(b.evidence.has('tool-result:checkpoint')).toBe(false)
    expect(a.state.slots.approval.status).toBe('succeeded')
  })

  it('preserves retry and loop causal identities without reusing earlier model instances', () => {
    const recorder = beginRound()
    recorder.recordChunk({ type: 'retry_reset' })
    reportWorkflow('root', { activeNodeId: 'retry', waitReason: 'retry', attempt: 1 })
    reportWorkflow('root', { attempt: 2 })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '准备请求' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '调用中' })
    expect(recordedGraph().evidence.has('retry:request')).toBe(true)
    reportWorkflow('root', { activeNodeId: 'checkpoint' })
    reportWorkflow('root', { activeNodeId: 'decision' })
    reportWorkflow('root', { newIteration: true, iteration: 2 })
    reportWorkflow('root', { attempt: 1, activeNodeId: 'model', phaseLabel: '准备请求' })
    reportWorkflow('root', { activeNodeId: 'model', phaseLabel: '调用中' })
    recorder.finish('succeeded')
    const result = recordedGraph()
    expect(result.evidence.has('decision:entry')).toBe(true)
    expect(result.evidence.has('entry:input')).toBe(true)
    expect(result.evidence.has('input:request')).toBe(true)
    expect(result.state.scope.iteration).toBe(2)
    for (const id of [
      'submission:queue',
      'queue:entry',
      'request:model',
      'model:error',
      'error:retry',
      'retry:request',
    ])
      expect(result.evidence.has(id), id).toBe(true)
    expect(result.occurrences.filter((o) => o.kind === 'model')).toHaveLength(3)
  })
})

beforeEach(() => {
  fixture.appendCalls = []
  fixture.gaps = []
  fixture.appendFailures = 0
  fixture.identityFailure = false
})

describe('workflow run recorder isolation', () => {
  it('records a descendant into the task root without a UI lease', () => {
    const recorder = startWorkflowRunRecorder('grandchild')
    expect(hasWorkflowObserver('grandchild')).toBe(true)
    expect(fixture.appendCalls[0]![0]).toMatchObject({
      rootChatId: 'root',
      chatId: 'grandchild',
      taskId: 'task',
      branchId: 'branch',
      runId: 'run',
      kind: 'context',
    })

    reportWorkflow('grandchild', {
      newIteration: true,
      iteration: 1,
      activeNodeId: 'model',
      status: 'running',
    })
    expect(fixture.appendCalls.flat().some((item) => item.kind === 'model')).toBe(true)
    recorder.finish('succeeded', 'normal')
    expect(hasWorkflowObserver('grandchild')).toBe(false)
  })

  it('marks a gap after a failed write and resumes without interrupting execution', () => {
    fixture.appendFailures = 1
    const recorder = startWorkflowRunRecorder('root')
    expect(() => reportWorkflow('root', { activeNodeId: 'input' })).not.toThrow()
    expect(fixture.gaps).toEqual([
      {
        rootChatId: 'root',
        chatId: 'root',
        runId: 'run',
        contextStageId: 'root:start',
        reason: 'write-failed',
      },
    ])
    expect(fixture.appendCalls.flat().some((item) => item.kind === 'input')).toBe(true)
    recorder.finish()
  })

  it('returns a harmless recorder when startup identity lookup fails', () => {
    fixture.identityFailure = true
    const recorder = startWorkflowRunRecorder('root')
    expect(hasWorkflowObserver('root')).toBe(false)
    expect(() => {
      recorder.recordChunk({ type: 'done' })
      recorder.recordCommittedMessage({ id: 'message', role: 'assistant' })
      recorder.finish()
    }).not.toThrow()
    expect(fixture.appendCalls).toEqual([])
  })

  it('separates request and tool processing boundaries without inventing execution', () => {
    const recorder = startWorkflowRunRecorder('root')
    reportWorkflow('root', {
      activeNodeId: 'model',
      phaseLabel: '准备请求',
      status: 'running',
    })
    reportWorkflow('root', {
      activeNodeId: 'model',
      phaseLabel: '调用中',
      waitReason: 'model',
    })
    reportWorkflow('root', {
      activeNodeId: 'model',
      phaseLabel: '处理响应',
      status: 'running',
    })
    recorder.recordChunk({
      type: 'sense_end',
      id: 'call',
      name: 'read_file',
      arguments: '{}',
      supervisionLevel: 0,
      security: {
        decision: 'allow',
        roleType: 'assistant',
        policyHash: 'policy',
        findings: [],
        assessmentHash: 'assessment',
      },
    })
    recorder.recordChunk({
      type: 'sense_started',
      id: 'call',
      name: 'read_file',
      arguments: '{}',
      startedAt: 1,
    })
    recorder.recordChunk({
      type: 'sense_accept',
      id: 'call',
      name: 'read_file',
      result: 'omitted',
    })
    recorder.finish('succeeded', 'normal')

    const events = fixture.appendCalls.flat()
    expect(events.filter((event) => event.kind === 'request').map((event) => event.status)).toEqual(
      ['running', 'succeeded'],
    )
    expect(events.some((event) => event.kind === 'model' && event.waitReason === 'model')).toBe(
      true,
    )
    for (const kind of [
      'tool-validation',
      'tool-authorization',
      'tool-preflight',
      'tool-execution',
      'tool-result',
    ])
      expect(events.some((event) => event.kind === kind)).toBe(true)
  })
})
