// Isolated recorder checks. Every persistence and identity dependency is mocked in memory.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  appendCalls: [] as any[][],
  gaps: [] as any[],
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
  appendWorkflowJournalEvents: (events: any[]) => {
    if (fixture.appendFailures > 0) {
      fixture.appendFailures--
      throw new Error('journal unavailable')
    }
    fixture.appendCalls.push(structuredClone(events))
  },
  recordWorkflowJournalGap: (gap: any) => fixture.gaps.push(structuredClone(gap)),
  readWorkflowStepSnapshot: () => ({ active: [] }),
}))
vi.mock('@/db/delivery.js', () => ({ getSpawnTaskByChild: () => undefined }))
vi.mock('@/service/chat/runtime.js', () => ({ getActiveChatRunId: () => 'run' }))

import { hasWorkflowObserver, reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { startWorkflowRunRecorder } from '@/service/chat/workflowRecorder.js'

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
