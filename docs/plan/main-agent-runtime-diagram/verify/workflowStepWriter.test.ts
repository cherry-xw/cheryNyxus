// Isolated external-step checks. Identity, snapshots and persistence stay in memory.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  events: [] as any[][],
  gaps: [] as any[],
  active: [] as any[],
  fail: false,
}))

vi.mock('@/db/chat.js', () => ({
  getRootChatId: (chatId: string) => chatId,
  getMessages: () => [],
}))
vi.mock('@/db/conversationBranch.js', () => ({
  getConversationBranchByChat: () => undefined,
  getConversationTask: () => undefined,
}))
vi.mock('@/db/workflowJournal.js', () => ({
  appendWorkflowJournalEvents: (events: any[]) => {
    if (fixture.fail) throw new Error('write failed')
    fixture.events.push(structuredClone(events))
  },
  readWorkflowStepSnapshot: () => ({ active: structuredClone(fixture.active) }),
  recordWorkflowJournalGap: (gap: any) => fixture.gaps.push(structuredClone(gap)),
}))

import { finishActiveWorkflowSteps, recordWorkflowStep } from '@/service/chat/workflowStepWriter.js'

beforeEach(() => {
  fixture.events = []
  fixture.gaps = []
  fixture.active = []
  fixture.fail = false
})

describe('external workflow step writer', () => {
  it('uses stable chat-scoped identities across queued and consumed transitions', () => {
    const queued = recordWorkflowStep('root', {
      kind: 'queue',
      key: 'input',
      scope: 'chat',
      runId: 'run-one',
      status: 'waiting',
      waitReason: 'queue',
      reason: 'queued',
      eventKey: 'queued',
    })
    const consumed = recordWorkflowStep('root', {
      kind: 'queue',
      key: 'input',
      scope: 'chat',
      runId: 'run-two',
      status: 'succeeded',
      reason: 'consumed',
      eventKey: 'consumed',
    })
    expect(consumed).toBe(queued)
    expect(fixture.events.flat().filter((event) => event.eventKind === 'started')).toHaveLength(2)
    expect(fixture.events.at(-1)?.at(-1)).toMatchObject({
      occurrenceId: queued,
      status: 'succeeded',
      reason: 'consumed',
    })
  })

  it('finishes only the matching durable wait with its original context identity', () => {
    fixture.active = [
      {
        occurrenceId: 'question',
        rootChatId: 'root',
        chatId: 'root',
        contextStageId: 'root:old-stage',
        kind: 'input',
        label: '接入输入',
        status: 'waiting',
        waitReason: 'answer',
        batchId: 'batch',
        anchors: [],
      },
      {
        occurrenceId: 'approval',
        rootChatId: 'root',
        chatId: 'root',
        contextStageId: 'root:start',
        kind: 'tool-approval',
        label: '等待工具审批',
        status: 'waiting',
        waitReason: 'approval',
        callId: 'call',
        anchors: [],
      },
    ]
    finishActiveWorkflowSteps('root', {
      kind: 'input',
      waitReason: 'answer',
      batchId: 'batch',
      status: 'succeeded',
      reason: 'consumed',
      eventKey: 'answer:batch',
    })
    expect(fixture.events.flat()).toEqual([
      expect.objectContaining({
        occurrenceId: 'question',
        contextStageId: 'root:old-stage',
        status: 'succeeded',
      }),
    ])
  })

  it('converts an isolated write failure into a best-effort completeness gap', () => {
    fixture.fail = true
    expect(
      recordWorkflowStep('root', {
        kind: 'wake',
        key: 'child',
        status: 'succeeded',
        reason: 'normal',
      }),
    ).toBeUndefined()
    expect(fixture.gaps).toEqual([
      expect.objectContaining({ rootChatId: 'root', chatId: 'root', reason: 'write-failed' }),
    ])
  })
})
