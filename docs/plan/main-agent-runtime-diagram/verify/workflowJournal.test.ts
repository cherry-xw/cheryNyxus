// In-memory workflow journal checks. This suite never opens configured or user databases.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ db: undefined as any }))

vi.mock('@/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workflow_journal_roots (
      root_chat_id TEXT PRIMARY KEY,
      next_sequence INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      history_generation INTEGER NOT NULL DEFAULT 0,
      history_complete INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE workflow_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      source_chat_id TEXT NOT NULL,
      task_id TEXT,
      branch_id TEXT,
      context_stage_id TEXT NOT NULL,
      run_id TEXT,
      iteration INTEGER,
      attempt INTEGER,
      batch_id TEXT,
      call_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(root_chat_id, first_sequence)
    );
    CREATE INDEX idx_workflow_occurrences_root_tail
      ON workflow_occurrences(root_chat_id, last_sequence DESC);
    CREATE TABLE workflow_step_events (
      event_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      root_sequence INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      occurrence_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_chat_id TEXT NOT NULL,
      branch_id TEXT,
      context_stage_id TEXT NOT NULL,
      run_id TEXT,
      event_kind TEXT NOT NULL,
      order_quality TEXT NOT NULL DEFAULT 'exact',
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(root_chat_id, root_sequence),
      UNIQUE(root_chat_id, source_key)
    );
    CREATE INDEX idx_workflow_events_root_sequence
      ON workflow_step_events(root_chat_id, root_sequence);
    CREATE INDEX idx_workflow_events_occurrence
      ON workflow_step_events(occurrence_id, root_sequence);
    CREATE TABLE workflow_journal_gaps (
      gap_id TEXT PRIMARY KEY,
      root_chat_id TEXT NOT NULL,
      from_sequence INTEGER NOT NULL,
      to_sequence INTEGER NOT NULL,
      source_chat_id TEXT,
      run_id TEXT,
      context_stage_id TEXT,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_workflow_gaps_root_sequence
      ON workflow_journal_gaps(root_chat_id, from_sequence, to_sequence);
  `)
  fixture.db = db
  return { getSoulDb: () => db }
})

import {
  appendWorkflowJournalEvents,
  deleteWorkflowJournalScope,
  onWorkflowJournalCommit,
  readWorkflowJournalPage,
  readWorkflowStepSnapshot,
  recordWorkflowJournalGap,
  type WorkflowJournalEventInput,
} from '@/db/workflowJournal.js'

function event(
  sourceKey: string,
  occurrenceId: string,
  overrides: Partial<WorkflowJournalEventInput> = {},
): WorkflowJournalEventInput {
  return {
    eventId: `event:${sourceKey}`,
    sourceKey,
    occurrenceId,
    rootChatId: 'root',
    chatId: 'root',
    eventKind: 'started',
    kind: 'context',
    label: '准备上下文',
    status: 'running',
    contextStageId: 'root:start',
    runId: 'run',
    at: 10,
    ...overrides,
  }
}

beforeEach(() => {
  fixture.db.exec(`
    DELETE FROM workflow_step_events;
    DELETE FROM workflow_occurrences;
    DELETE FROM workflow_journal_gaps;
    DELETE FROM workflow_journal_roots;
  `)
})

describe('append-only workflow journal', () => {
  it('folds a same-batch lifecycle and ignores duplicate source keys', () => {
    const commit = appendWorkflowJournalEvents([
      event('context:start', 'context'),
      event('context:done', 'context', {
        eventKind: 'status',
        status: 'succeeded',
        reason: 'normal',
        at: 11,
      }),
    ])!
    expect(commit.events.map((item) => item.sequence)).toEqual([1, 2])
    expect(commit.revision).toBe(1)
    expect(readWorkflowJournalPage({ rootChatId: 'root' }).occurrences[0]).toMatchObject({
      occurrenceId: 'context',
      status: 'succeeded',
      firstSequence: 1,
      lastSequence: 2,
      startedAt: 10,
      endedAt: 11,
    })

    const duplicate = appendWorkflowJournalEvents([event('context:start', 'context')])!
    expect(duplicate).toMatchObject({ revision: 1, events: [] })
    expect(readWorkflowStepSnapshot('root').upperSequence).toBe(2)
  })

  it('keeps terminal status immutable while accepting a later explicit anchor', () => {
    appendWorkflowJournalEvents([
      event('model:start', 'model', { kind: 'model', label: '模型交互' }),
      event('model:done', 'model', {
        eventKind: 'status',
        kind: 'model',
        label: '模型交互',
        status: 'succeeded',
        at: 11,
      }),
    ])
    expect(
      appendWorkflowJournalEvents([
        event('model:flip', 'model', {
          eventKind: 'status',
          kind: 'model',
          label: '模型交互',
          status: 'failed',
          at: 12,
        }),
      ])!.events,
    ).toEqual([])
    appendWorkflowJournalEvents([
      event('model:anchor', 'model', {
        eventKind: 'anchor-added',
        kind: 'model',
        label: '模型交互',
        status: undefined,
        anchor: { kind: 'message', id: 'assistant', chatId: 'root' },
        at: 13,
      }),
    ])
    const occurrence = readWorkflowJournalPage({ rootChatId: 'root' }).occurrences[0]!
    expect(occurrence.status).toBe('succeeded')
    expect(occurrence.endedAt).toBe(11)
    expect(occurrence.anchors).toEqual([{ kind: 'message', id: 'assistant', chatId: 'root' }])
  })

  it('publishes only committed facts and isolates listener failures', () => {
    const commits: number[] = []
    const stopBroken = onWorkflowJournalCommit(() => {
      throw new Error('projection failed')
    })
    const stopHealthy = onWorkflowJournalCommit((commit) => commits.push(commit.revision))
    expect(() => appendWorkflowJournalEvents([event('input:start', 'input')])).not.toThrow()
    expect(commits).toEqual([1])
    stopBroken()
    stopHealthy()
  })

  it('records a recoverable sequence gap and marks snapshots incomplete', () => {
    appendWorkflowJournalEvents([event('before-gap', 'before')])
    const gap = recordWorkflowJournalGap({
      rootChatId: 'root',
      chatId: 'root',
      runId: 'run',
      contextStageId: 'root:start',
      reason: 'write-failed',
    })
    const after = appendWorkflowJournalEvents([event('after-gap', 'after')])!
    expect(gap.gaps[0]).toMatchObject({ fromSequence: 2, toSequence: 2 })
    expect(after.events[0]!.sequence).toBe(3)
    expect(readWorkflowStepSnapshot('root')).toMatchObject({
      revision: 3,
      upperSequence: 3,
      historyComplete: false,
    })
  })

  it('freezes the first-page upper bound and applies indexed scope filters', () => {
    appendWorkflowJournalEvents([
      event('a', 'a', { branchId: 'branch-a', contextStageId: 'stage-a' }),
      event('b', 'b', {
        chatId: 'child',
        branchId: 'branch-a',
        contextStageId: 'stage-b',
      }),
      event('c', 'c', { branchId: 'branch-b', contextStageId: 'stage-a' }),
    ])
    const first = readWorkflowJournalPage({ rootChatId: 'root', branchId: 'branch-a', limit: 1 })
    expect(first.events.map((item) => item.occurrenceId)).toEqual(['a'])
    expect(first.complete).toBe(false)

    appendWorkflowJournalEvents([event('d', 'd', { branchId: 'branch-a' })])
    const second = readWorkflowJournalPage({
      rootChatId: 'root',
      branchId: 'branch-a',
      upperSequence: first.upperSequence,
      afterSequence: first.events[0]!.sequence,
      limit: 10,
    })
    expect(second.events.map((item) => item.occurrenceId)).toEqual(['b'])
    expect(second.complete).toBe(true)
    expect(
      readWorkflowJournalPage({ rootChatId: 'root', chatId: 'child' }).events.map(
        (item) => item.occurrenceId,
      ),
    ).toEqual(['b'])
    expect(
      readWorkflowJournalPage({ rootChatId: 'root', contextStageId: 'stage-a' }).events.map(
        (item) => item.occurrenceId,
      ),
    ).toEqual(['a', 'c'])
  })

  it('deletes one chat scope without removing its root and can delete the whole root', () => {
    appendWorkflowJournalEvents([
      event('root-event', 'root-occurrence'),
      event('child-event', 'child-occurrence', { chatId: 'child' }),
    ])
    recordWorkflowJournalGap({ rootChatId: 'root', chatId: 'child', reason: 'unknown' })
    deleteWorkflowJournalScope('root', 'child', false)
    expect(readWorkflowJournalPage({ rootChatId: 'root' }).events).toHaveLength(1)
    expect(readWorkflowJournalPage({ rootChatId: 'root', chatId: 'child' }).events).toEqual([])
    expect(() => readWorkflowJournalPage({ rootChatId: 'root', historyGeneration: 0 })).toThrow(
      '历史在加载期间发生变化',
    )

    deleteWorkflowJournalScope('root', 'root', true)
    expect(readWorkflowStepSnapshot('root')).toMatchObject({ revision: 0, upperSequence: 0 })
  })

  it('rejects oversized batches and cross-root occurrence reuse', () => {
    expect(() =>
      appendWorkflowJournalEvents(
        Array.from({ length: 101 }, (_, index) => event(`too-many:${index}`, `o:${index}`)),
      ),
    ).toThrow('limited to 100')
    appendWorkflowJournalEvents([event('root-a', 'shared')])
    expect(() =>
      appendWorkflowJournalEvents([
        event('root-b', 'shared', { rootChatId: 'other', chatId: 'other' }),
      ]),
    ).toThrow('identity cannot change')
  })
})
