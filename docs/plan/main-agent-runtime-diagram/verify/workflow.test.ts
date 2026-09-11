// In-memory module fixtures; never opens a database, provider or graphical interface.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WorkflowOpenRequestSchema,
  WorkflowSnapshotSchema,
  WorkflowHistoryRequestSchema,
} from '@chery/protocol'
const fixture = vi.hoisted(() => ({
  rows: [] as any[],
  nodes: [] as any[],
  links: [] as any[],
  memory: undefined as any,
  events: [] as Array<(chatId: string, event: any) => void>,
  close: [] as Array<(connectionId: string) => void>,
  outputs: new Map<string, any>(),
  active: [] as any[],
  notifications: [] as any[],
  lifecycle: [] as Array<(data: any) => void>,
  archived: false,
  deleted: false,
  pending: [] as any[],
  workflowCommits: [] as Array<(commit: any) => void>,
  workflowRevision: 0,
}))
vi.mock('@/db/chat.js', () => ({
  getChat: (id: string) =>
    id === 'missing' || fixture.deleted
      ? undefined
      : {
          id,
          parent_chat_id: id === 'child' ? 'root' : null,
          lifecycle: fixture.archived ? 'archived' : 'active',
        },
  getMessages: () => fixture.rows,
  getMessageLinksForRoot: () => fixture.links,
  getChatRuntimeSelection: () => undefined,
}))
vi.mock('@/db/executionGraph.js', () => ({
  listExecutionNodes: () => fixture.nodes,
  listLatestExecutionRuns: () => fixture.active,
}))
vi.mock('@/db/epoch.js', () => ({
  getActiveChatEpoch: () => ({ epochId: 'epoch', status: 'active' }),
  getFrozenChatSnapshot: () => ({ resources: { workflow: { memoryCount: 8, skillCount: 1 } } }),
  listChatEpochs: () => [],
}))
vi.mock('@/db/interaction.js', () => ({ listInteractions: () => fixture.pending }))
vi.mock('@/db/conversationBranch.js', () => ({
  getConversationBranchByChat: () => undefined,
  getConversationTask: () => undefined,
}))
vi.mock('@/db/workflowJournal.js', () => ({
  onWorkflowJournalCommit: (callback: (commit: any) => void) => {
    fixture.workflowCommits.push(callback)
    return () => {
      const index = fixture.workflowCommits.indexOf(callback)
      if (index >= 0) fixture.workflowCommits.splice(index, 1)
    }
  },
  readWorkflowStepSnapshot: (rootChatId: string) => ({
    rootChatId,
    revision: fixture.workflowRevision,
    upperSequence: 0,
    active: [],
    recentEvents: [],
    gaps: [],
    hasEarlier: false,
    historyComplete: true,
  }),
  readWorkflowJournalPage: () => ({
    revision: fixture.workflowRevision,
    historyGeneration: 0,
    upperSequence: 0,
    events: [],
    occurrences: [],
    gaps: [],
    complete: true,
    historyComplete: true,
  }),
  listWorkflowJournalStages: () => [],
}))
vi.mock('@/db/delivery.js', () => ({
  onPreparedChatEvent: (callback: any) => fixture.events.push(callback),
}))
vi.mock('@/service/chat/lifecycleEvents.js', () => ({
  onChatLifecycle: (callback: any) => fixture.lifecycle.push(callback),
}))
vi.mock('@/service/chat/runtime.js', () => ({
  peekChatMessages: () => fixture.memory,
  isChatRunning: () => false,
  getActiveChatRunId: () => undefined,
}))
vi.mock('@/service/chat/currentState.js', () => ({
  computeCurrentState: () => ({ runningTools: [], executionSteps: [] }),
}))
vi.mock('@/agent/hooks/registry.js', () => ({ loadHookRegistry: () => ({}) }))
vi.mock('@/utils/config.js', () => ({ default: { llm: { brain: {} } } }))
vi.mock('@/service/message/types.js', async () => ({
  Method: (await import('@chery/protocol')).Method,
  createNotification: (type: string, _: unknown, data: unknown) => ({ type, data }),
}))
vi.mock('@/service/websocket/connection.js', () => ({
  connectionManager: {
    onClose: (callback: any) => fixture.close.push(callback),
    getWsByConnectionId: (id: string) => fixture.outputs.get(id),
  },
}))
vi.mock('@/service/websocket/transport.js', () => ({
  transport: { encode: (data: unknown) => data },
}))
import { openWorkflow, closeWorkflow, initialWorkflowSnapshot } from '@/service/chat/workflow.js'
import { readWorkflowHistory } from '@/service/chat/workflowHistory.js'
import { effectiveSkillCount } from '@/service/chat/workflowEvidence.js'
import {
  hasWorkflowObserver,
  reportWorkflow,
  observeWorkflow,
} from '@/core/middleware/workflowObservation.js'

function row(id: string, role: string, content = '', extra = {}) {
  return {
    id,
    chat_id: 'root',
    role,
    content,
    sense_calls: null,
    revoked: 0,
    replace_state: 0,
    created_at: 1,
    ...extra,
  }
}
function ctx(connectionId: string) {
  return { connectionId, requestId: 'request' } as any
}
beforeEach(() => {
  fixture.close.forEach((close) => {
    close('one')
    close('two')
  })
  fixture.rows = []
  fixture.nodes = []
  fixture.links = []
  fixture.active = []
  fixture.memory = undefined
  fixture.notifications = []
  fixture.archived = false
  fixture.deleted = false
  fixture.pending = []
  fixture.workflowRevision = 0
  for (const id of ['one', 'two'])
    fixture.outputs.set(id, {
      OPEN: 1,
      readyState: 1,
      send: (event: any) => fixture.notifications.push({ id, ...structuredClone(event) }),
    })
})
describe('workflow contract and observation isolation', () => {
  it('validates identities, counters and old optional resources', () => {
    expect(WorkflowOpenRequestSchema.safeParse({ chatId: '', observerId: 'a' }).success).toBe(false)
    expect(WorkflowHistoryRequestSchema.safeParse({ chatId: 'root', limit: 201 }).success).toBe(
      false,
    )
    expect(
      WorkflowSnapshotSchema.safeParse({
        chatId: 'root',
        rootChatId: 'root',
        contextStageId: 'root:start',
        revision: 0,
        status: 'unknown',
        visitedNodeIds: [],
        dispatches: [],
        resources: { loadedSkillsComplete: false },
        phaseKnown: false,
        historyComplete: false,
      }).success,
    ).toBe(true)
  })
  it('shares projection and sends only committed journal updates to owning windows', async () => {
    const first = await openWorkflow(ctx('one'), { chatId: 'root', observerId: 'window-a' })
    const duplicate = await openWorkflow(ctx('one'), { chatId: 'root', observerId: 'window-a' })
    const second = await openWorkflow(ctx('two'), { chatId: 'root', observerId: 'window-b' })
    expect(duplicate.subscriptionId).toBe(first.subscriptionId)
    expect(second.streamId).toBe(first.streamId)
    expect(hasWorkflowObserver('child')).toBe(false)
    fixture.workflowRevision = 1
    fixture.workflowCommits[0]!({
      rootChatId: 'root',
      baseRevision: 0,
      revision: 1,
      events: [],
      gaps: [],
    })
    expect(fixture.notifications.map((notification) => notification.id)).toEqual(['one', 'two'])
    fixture.notifications = []
    reportWorkflow('root', {
      activeNodeId: 'tools',
      batch: {
        id: 'batch',
        complete: true,
        calls: [
          { id: 'a', name: 'read', status: 'pending' },
          { id: 'b', name: 'read', status: 'pending' },
        ],
      },
    })
    expect(fixture.notifications).toEqual([])
    expect((await closeWorkflow(ctx('two'), { subscriptionId: first.subscriptionId })).closed).toBe(
      false,
    )
    await closeWorkflow(ctx('one'), { subscriptionId: first.subscriptionId })
    fixture.workflowRevision = 2
    fixture.workflowCommits[0]!({
      rootChatId: 'root',
      baseRevision: 1,
      revision: 2,
      events: [],
      gaps: [],
    })
    expect(fixture.notifications.map((n) => n.id)).toEqual(['two'])
    fixture.close.forEach((close) => close('two'))
    expect(hasWorkflowObserver('root')).toBe(false)
    const count = fixture.notifications.length
    fixture.workflowRevision = 3
    fixture.workflowCommits[0]!({
      rootChatId: 'root',
      baseRevision: 2,
      revision: 3,
      events: [],
      gaps: [],
    })
    expect(fixture.notifications).toHaveLength(count)
    const reopened = await openWorkflow(ctx('one'), { chatId: 'root', observerId: 'window-a' })
    expect(reopened.streamId).not.toBe(first.streamId)
  })
  it('rejects missing/child roots and isolates callback failures', async () => {
    await expect(
      openWorkflow(ctx('one'), { chatId: 'child', observerId: 'a' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(() => readWorkflowHistory({ chatId: 'missing' })).toThrow()
    const observed: string[] = []
    const stop = observeWorkflow('throwing', () => {
      throw new Error('observer broken')
    })
    const stopSecond = observeWorkflow('throwing', (boundary) => {
      if (boundary.activeNodeId) observed.push(boundary.activeNodeId)
    })
    expect(() => reportWorkflow('throwing', { activeNodeId: 'input' })).not.toThrow()
    expect(observed).toEqual(['input'])
    stop()
    stopSecond()
  })
  it('releases active callbacks on archive and all leases on deletion', async () => {
    await openWorkflow(ctx('one'), { chatId: 'root', observerId: 'a' })
    fixture.archived = true
    fixture.lifecycle.forEach((callback) => callback({ action: 'archived', chatIds: ['root'] }))
    expect(hasWorkflowObserver('root')).toBe(false)
    expect(readWorkflowHistory({ chatId: 'root' }).facts).toEqual([])
    fixture.deleted = true
    fixture.lifecycle.forEach((callback) => callback({ action: 'deleted', chatIds: ['root'] }))
    expect(fixture.notifications.at(-1).data.invalidated).toBe(true)
    await expect(
      openWorkflow(ctx('one'), { chatId: 'root', observerId: 'a' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('distinguishes child/interaction waits from authoritative termination', async () => {
    fixture.active = [{ chatId: 'root', runId: 'run', status: 'paused' }]
    fixture.nodes = [
      {
        id: 'a',
        sourceChatId: 'root',
        runId: 'run',
        workflow: { outcome: 'waiting', outcomeRunId: 'run' },
      },
    ]
    expect(initialWorkflowSnapshot('root')).toMatchObject({
      status: 'running',
      waitReason: 'child',
    })
    await openWorkflow(ctx('one'), { chatId: 'root', observerId: 'a' })
    fixture.nodes.push({
      id: 'stop',
      sourceChatId: 'root',
      runId: 'run',
      termination: { code: 'user_abort' },
    })
    fixture.events.forEach((callback) =>
      callback('root', {
        kind: 'notification',
        type: 'run.updated',
        data: { runId: 'run', status: 'paused' },
      }),
    )
    expect(fixture.notifications).toEqual([])
    const refreshed = await openWorkflow(ctx('one'), { chatId: 'root', observerId: 'a' })
    expect(refreshed.snapshot).toMatchObject({
      status: 'paused',
      activeNodeId: 'result',
    })
    expect(initialWorkflowSnapshot('root').status).toBe('paused')
    fixture.pending = [{ chatId: 'root', status: 'pending', kind: 'question_batch' }]
    expect(initialWorkflowSnapshot('root')).toMatchObject({
      status: 'paused',
      activeNodeId: 'result',
    })
    fixture.nodes.pop()
    expect(initialWorkflowSnapshot('root')).toMatchObject({
      status: 'running',
      waitReason: 'answer',
    })
  })
})
describe('long-term history without journals', () => {
  it('returns whole batches, known outcomes and stable paginated facts', () => {
    fixture.rows = [
      row('u', 'user', 'hello'),
      row('a', 'assistant', '', {
        sense_calls: JSON.stringify([
          { id: 'c1', name: 'read' },
          { id: 'c2', name: 'read' },
        ]),
      }),
      row('c1', 'sense', 'ok'),
      row('c2', 'sense', '感官执行失败：bad'),
    ]
    fixture.nodes = [
      {
        id: 'a',
        sourceMessageId: 'a',
        sourceChatId: 'root',
        createdAt: 1,
        workflow: { outcome: 'completed' },
      },
    ]
    const first = readWorkflowHistory({ chatId: 'root', limit: 1 })
    expect(first.complete).toBe(false)
    const next = readWorkflowHistory({ chatId: 'root', cursor: first.nextCursor })
    expect(next.boundary).toBe(first.boundary)
    const batch = next.facts.find((f) => f.batch)?.batch
    expect(batch?.calls.map((call) => call.status)).toEqual(['completed', 'failed'])
    expect(next.facts.at(-1)?.status).toBe('completed')
    expect(() => readWorkflowHistory({ chatId: 'other', cursor: first.nextCursor })).toThrow()
    fixture.rows[0].revoked = 1
    expect(() => readWorkflowHistory({ chatId: 'root', cursor: first.nextCursor })).toThrow(
      '历史在加载期间发生变化',
    )
  })
  it('only confirmed compression changes the active stage, with post-summary skill counts', () => {
    fixture.rows = [
      row('u', 'user'),
      row('summary', 'assistant', 'summary', { context_compaction: 1 }),
    ]
    expect(readWorkflowHistory({ chatId: 'root' }).stages).toHaveLength(1)
    fixture.nodes = [
      {
        id: 'summary',
        sourceMessageId: 'summary',
        sourceChatId: 'root',
        createdAt: 1,
        workflow: { compaction: { applied: true } },
      },
    ]
    fixture.rows.push(
      row('a', 'assistant', '', { sense_calls: '[{"id":"s","name":"skill"}]' }),
      row('s', 'sense', '"one"技能已激活。以下是完整指令，请严格遵守：\n\nbody'),
    )
    const result = readWorkflowHistory({ chatId: 'root' })
    expect(result.contextStageId).toBe('root:summary')
    expect(result.resources.loadedSkillCount).toBe(1)
    expect(result.resources.memoryCount).toBeUndefined()
  })
  it('does not count errors, replaced or revoked skill bodies; permits more loaded than discovered', () => {
    const rows = [
      row('a', 'assistant', '', {
        sense_calls: JSON.stringify(['1', '2', '3', '4'].map((id) => ({ id, name: 'skill' }))),
      }),
      row('1', 'sense', '"x"技能已激活。以下是完整指令，请严格遵守：\n\nbody'),
      row('2', 'sense', '"x"技能已激活。以下是完整指令，请严格遵守：\n\nbody'),
      row('3', 'sense', 'Error: skill "bad" not found'),
      row('4', 'sense', '"y"技能已激活。以下是完整指令，请严格遵守：\n\nbody', {
        replace_state: 1,
      }),
    ]
    expect(effectiveSkillCount(rows).loadedSkillCount).toBe(1)
    rows[1].revoked = 1
    rows[2].revoked = 1
    expect(effectiveSkillCount(rows).loadedSkillCount).toBe(0)
  })
  it('recovers only parent dispatch and consumed child return boundaries', () => {
    fixture.rows = [
      row('input', 'user', '', { created_at: 1 }),
      row('return', 'user', '', { created_at: 3 }),
    ]
    fixture.nodes = [
      {
        id: 'spawn',
        kind: 'dispatch',
        actor: { chatId: 'root' },
        targetChatId: 'child',
        sourceChatId: 'child',
        createdAt: 2,
      },
      {
        id: 'nested',
        kind: 'dispatch',
        actor: { chatId: 'child' },
        targetChatId: 'grandchild',
        sourceChatId: 'grandchild',
        createdAt: 2,
      },
    ]
    fixture.links = [{ messageId: 'return', sourceChatId: 'child', relation: 'child_return' }]
    const facts = readWorkflowHistory({ chatId: 'root' }).facts
    expect(facts.map((fact) => fact.id)).toEqual(['input', 'spawn', 'return'])
    expect(facts[1].dispatches[0].status).toBe('waiting')
    expect(facts[2].dispatches[0].status).toBe('returned')
    expect(initialWorkflowSnapshot('root').dispatches).toEqual([
      { id: 'child', name: '子 Agent', status: 'returned' },
    ])
  })
})
