import { describe, expect, it } from 'vitest'
import type {
  ChatSessionEvent,
  ExecutionStep,
  RootTimelineSnapshot,
  TimelineNode,
} from '../../src/services/agentApi'
import { createEmptySession, applyCurrentState } from '../../src/stores/chats/hydration'
import { reduceSessionEvent } from '../../src/stores/chats/reducer'
import {
  FULL_EXECUTION_PRESENTATION,
  LITE_EXECUTION_PRESENTATION,
  selectExecutionReadModel,
} from '../../src/stores/chats/executionReadModel'
import {
  applyRootTransientEvent,
  createRootTransientState,
} from '../../src/stores/chats/rootTimeline'
import { applyExecutionTimingEvent } from '../../src/stores/chats/executionTiming'

function userNode(rootChatId: string, id: string, content: string, orderKey: number): TimelineNode {
  return {
    id,
    rootChatId,
    sourceChatId: rootChatId,
    sourceMessageId: id,
    kind: 'message',
    actor: { kind: 'user', actorId: 'human' },
    target: { kind: 'agent', chatId: rootChatId },
    direction: 'user-to-agent',
    visibility: 'conversation',
    content,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
  }
}

function assistantNode(
  rootChatId: string,
  sourceChatId: string,
  id: string,
  content: string,
  orderKey: number,
): TimelineNode {
  return {
    id,
    rootChatId,
    sourceChatId,
    sourceMessageId: id,
    kind: 'message',
    actor: { kind: 'agent', chatId: sourceChatId },
    target: { kind: 'user', actorId: 'human' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
  }
}

function timeline(rootChatId: string, nodes: TimelineNode[]): RootTimelineSnapshot {
  return {
    rootChatId,
    view: 'conversation',
    revision: 1,
    nodes,
    edges: [],
    activeRuns: [],
    pendingInputs: [],
    generations: [],
    capturedEventSeq: 1,
  }
}

function timedEvents(chatId = 'root'): ChatSessionEvent[] {
  const values: Array<[string, Record<string, unknown>]> = [
    ['run.updated', { runId: 'run-1', status: 'running', at: 105, startedAt: 105 }],
    ['turn.started', { runId: 'run-1', turnId: 'turn-1', messageId: 'model-1', createdAt: 110 }],
    ['turn.completed', { runId: 'run-1', turnId: 'turn-1', messageId: 'model-1', completedAt: 130 }],
    ['sense_started', { runId: 'run-1', id: 'tool-1', senseName: 'search', startedAt: 140 }],
    ['accept', { runId: 'run-1', approvalId: 'tool-1', senseName: 'search', result: 'ok', completedAt: 150 }],
    ['run.updated', { runId: 'run-1', status: 'completed', at: 160 }],
  ]
  return values.map(([type, data], index) => ({
    kind: 'session',
    type,
    chatId,
    eventSeq: index + 1,
    data,
  }))
}

const expectedSteps: ExecutionStep[] = [
  {
    id: 'turn-1',
    runId: 'run-1',
    chatId: 'root',
    kind: 'model',
    name: '模型响应',
    status: 'completed',
    startedAt: 110,
    completedAt: 130,
  },
  {
    id: 'tool-1',
    runId: 'run-1',
    chatId: 'root',
    kind: 'tool',
    name: 'search',
    status: 'completed',
    startedAt: 140,
    completedAt: 150,
  },
]

describe('canonical execution read model', () => {
  it('projects currentState, live events and replayed duplicate events identically', () => {
    const rootTimeline = timeline('root', [
      userNode('root', 'question', '怎么实现？', 100),
      assistantNode('root', 'root', 'answer', '最终答案', 155),
    ])

    const snapshot = createEmptySession('root')
    applyCurrentState(
      snapshot,
      {
        runningTools: [],
        executionSteps: expectedSteps,
        runTiming: { runId: 'run-1', startedAt: 105 },
      },
      160,
    )
    snapshot.activeRun = {
      chatId: 'root',
      runId: 'run-1',
      status: 'completed',
      startedAt: 105,
      at: 160,
    }

    const live = createEmptySession('root')
    const replay = createEmptySession('root')
    for (const event of timedEvents()) {
      expect(reduceSessionEvent(live, event, { now: 999 })).toBe(true)
      expect(reduceSessionEvent(replay, event, { now: 999 })).toBe(true)
      expect(reduceSessionEvent(replay, event, { now: 1999 })).toBe(true)
    }

    const project = (session: typeof snapshot) =>
      selectExecutionReadModel({
        rootChatId: 'root',
        sessionsById: { root: session },
        timeline: rootTimeline,
      })

    expect(project(snapshot)).toEqual(project(live))
    expect(project(replay)).toEqual(project(live))
    expect(project(live)).toMatchObject({
      currentQuestion: { id: 'question', content: '怎么实现？', createdAt: 100 },
      status: 'completed',
      runId: 'run-1',
      startedAt: 100,
      completedAt: 160,
      finalResponse: { id: 'answer', content: '最终答案' },
      steps: [
        { id: 'turn-1', kind: 'model', startedAt: 110, completedAt: 130 },
        { id: 'tool-1', kind: 'tool', name: 'search', startedAt: 140, completedAt: 150 },
      ],
    })
  })

  it('keeps parallel child agents and their independent running timers', () => {
    const root = createEmptySession('root')
    const childA = createEmptySession('child-a', { parentChatId: 'root', agentType: '研究员' })
    const childB = createEmptySession('child-b', { parentChatId: 'root', agentType: '审查员' })
    const transient = createRootTransientState({
      runs: [
        { chatId: 'root', runId: 'root-run', status: 'waiting', startedAt: 105 },
        { chatId: 'child-a', runId: 'run-a', status: 'running', startedAt: 120 },
        { chatId: 'child-b', runId: 'run-b', status: 'running', startedAt: 121 },
      ],
      executionSteps: [
        {
          id: 'turn-a', runId: 'run-a', chatId: 'child-a', kind: 'model', name: '模型响应', status: 'running', startedAt: 122,
        },
        {
          id: 'tool-b', runId: 'run-b', chatId: 'child-b', kind: 'tool', name: 'review', status: 'running', startedAt: 123,
        },
      ],
    })

    const model = selectExecutionReadModel({
      rootChatId: 'root',
      sessionsById: { root, 'child-a': childA, 'child-b': childB },
      timeline: timeline('root', [userNode('root', 'question', '并行处理', 100)]),
      transient,
    })

    expect(model.status).toBe('running')
    expect(model.steps.map((step) => [step.chatId, step.agentLabel, step.status])).toEqual([
      ['child-a', '研究员', 'running'],
      ['child-b', '审查员', 'running'],
    ])
    expect(model.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: 'child-a', status: 'running', startedAt: 120 }),
        expect.objectContaining({ chatId: 'child-b', status: 'running', startedAt: 121 }),
      ]),
    )
  })

  it('shows only the last root response after the whole root run completes', () => {
    const root = createEmptySession('root')
    const child = createEmptySession('child', { parentChatId: 'root' })
    const rootTimeline = timeline('root', [
      assistantNode('root', 'root', 'final', '根流程最后正文', 170),
      assistantNode('root', 'child', 'child-answer', '子 Agent 正文', 130),
      userNode('root', 'question', '当前问题', 100),
      assistantNode('root', 'root', 'intermediate', '中间正文', 120),
    ])
    const transient = createRootTransientState({
      runs: [{ chatId: 'root', runId: 'run-1', status: 'running', startedAt: 105 }],
    })
    const source = {
      rootChatId: 'root',
      sessionsById: { root, child },
      timeline: rootTimeline,
      transient,
    }

    expect(selectExecutionReadModel(source).finalResponse).toBeUndefined()
    applyRootTransientEvent(transient, {
      chatId: 'root',
      type: 'run.updated',
      data: { runId: 'run-1', status: 'completed', at: 180 },
    })
    expect(selectExecutionReadModel(source).finalResponse).toMatchObject({
      id: 'final',
      content: '根流程最后正文',
    })
  })

  it('does not leak question or final response when switching roots', () => {
    const rootA = createEmptySession('root-a')
    const rootB = createEmptySession('root-b')
    const sessionsById = { 'root-a': rootA, 'root-b': rootB }
    const modelA = selectExecutionReadModel({
      rootChatId: 'root-a',
      sessionsById,
      timeline: timeline('root-a', [
        userNode('root-a', 'question-a', '问题 A', 10),
        assistantNode('root-a', 'root-a', 'answer-a', '答案 A', 20),
      ]),
    })
    const modelB = selectExecutionReadModel({
      rootChatId: 'root-b',
      sessionsById,
      timeline: timeline('root-b', [
        userNode('root-b', 'question-b', '问题 B', 30),
        assistantNode('root-b', 'root-b', 'answer-b', '答案 B', 40),
      ]),
    })

    expect(modelA.currentQuestion?.content).toBe('问题 A')
    expect(modelA.finalResponse?.content).toBe('答案 A')
    expect(modelB.currentQuestion?.content).toBe('问题 B')
    expect(modelB.finalResponse?.content).toBe('答案 B')
  })

  it('prefers the root input that entered execution and ignores queued or child inputs', () => {
    const root = createEmptySession('root')
    const child = createEmptySession('child', { parentChatId: 'root' })
    const transient = createRootTransientState({
      pendingInputs: [
        { chatId: 'child', inputId: 'child-input', content: '子任务输入', state: 'started', acceptedAt: 210 },
        { chatId: 'root', inputId: 'queued', content: '下一条排队问题', state: 'queued', acceptedAt: 220 },
        { chatId: 'root', inputId: 'current', content: '刚开始的问题', state: 'started', acceptedAt: 200 },
      ],
      runs: [{ chatId: 'root', runId: 'run-2', status: 'running', startedAt: 200 }],
    })

    const model = selectExecutionReadModel({
      rootChatId: 'root',
      sessionsById: { root, child },
      timeline: timeline('root', [userNode('root', 'old-question', '上一轮问题', 100)]),
      transient,
    })

    expect(model.currentQuestion).toEqual({
      id: 'current',
      content: '刚开始的问题',
      createdAt: 200,
    })
    expect(model.startedAt).toBe(200)
  })

  it('does not reuse an old final response while the next question is pending timeline commit', () => {
    const root = createEmptySession('root')
    const transient = createRootTransientState({
      pendingInputs: [
        {
          chatId: 'root',
          inputId: 'new-question',
          content: '新问题',
          state: 'started',
          acceptedAt: 200,
        },
      ],
      runs: [{ chatId: 'root', runId: 'run-2', status: 'completed', startedAt: 200, at: 250 }],
    })

    const model = selectExecutionReadModel({
      rootChatId: 'root',
      sessionsById: { root },
      timeline: timeline('root', [
        userNode('root', 'old-question', '旧问题', 100),
        assistantNode('root', 'root', 'old-answer', '旧答案', 150),
      ]),
      transient,
    })

    expect(model.currentQuestion?.id).toBe('new-question')
    expect(model.status).toBe('completed')
    expect(model.finalResponse).toBeUndefined()
  })

  it('keeps late and duplicate timing facts idempotent without reopening a terminal step', () => {
    const completion = {
      chatId: 'root',
      runId: 'run-1',
      type: 'turn.completed',
      data: { runId: 'run-1', turnId: 'turn-1', completedAt: 130 },
    }
    const start = {
      chatId: 'root',
      runId: 'run-1',
      type: 'turn.started',
      data: { runId: 'run-1', turnId: 'turn-1', createdAt: 110 },
    }
    let steps = applyExecutionTimingEvent([], completion)
    steps = applyExecutionTimingEvent(steps, completion)
    steps = applyExecutionTimingEvent(steps, start)
    steps = applyExecutionTimingEvent(steps, start)

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'turn-1',
        status: 'completed',
        startedAt: 110,
        completedAt: 130,
      }),
    ])
  })

  it('does not downgrade a failed model step when turn.completed arrives late', () => {
    let steps = applyExecutionTimingEvent([], {
      chatId: 'root',
      runId: 'run-1',
      type: 'turn.started',
      data: { runId: 'run-1', turnId: 'turn-1', createdAt: 110 },
    })
    steps = applyExecutionTimingEvent(steps, {
      chatId: 'root',
      runId: 'run-1',
      type: 'error',
      data: { runId: 'run-1', completedAt: 130 },
    })
    steps = applyExecutionTimingEvent(steps, {
      chatId: 'root',
      runId: 'run-1',
      type: 'turn.completed',
      data: { runId: 'run-1', turnId: 'turn-1', completedAt: 140 },
    })

    expect(steps[0]).toMatchObject({ status: 'failed', completedAt: 130 })
  })

  it('seals unfinished steps as cancelled when done remains resumable', () => {
    let steps = applyExecutionTimingEvent([], {
      chatId: 'root',
      runId: 'run-1',
      type: 'sense_started',
      data: { runId: 'run-1', id: 'tool-1', senseName: 'search', startedAt: 110 },
    })
    steps = applyExecutionTimingEvent(steps, {
      chatId: 'root',
      runId: 'run-1',
      type: 'done',
      data: { runId: 'run-1', canResume: true, completedAt: 130 },
    })

    expect(steps[0]).toMatchObject({ status: 'cancelled', completedAt: 130 })
  })

  it('derives failed, rejected and cancelled tool terminals from canonical events', () => {
    const apply = (
      steps: ExecutionStep[],
      type: string,
      data: Record<string, unknown>,
    ) => applyExecutionTimingEvent(steps, { chatId: 'root', runId: 'run-1', type, data })
    let steps: ExecutionStep[] = []
    steps = apply(steps, 'sense_started', {
      runId: 'run-1', id: 'failed', senseName: 'broken', startedAt: 10,
    })
    steps = apply(steps, 'accept', {
      runId: 'run-1', approvalId: 'failed', senseName: 'broken',
      result: '感官执行失败：boom', completedAt: 20,
    })
    steps = apply(steps, 'rejected', {
      runId: 'run-1', approvalId: 'rejected', senseName: 'dangerous',
      reason: 'denied', completedAt: 30,
    })
    steps = apply(steps, 'sense_started', {
      runId: 'run-1', id: 'cancelled', senseName: 'slow', startedAt: 40,
    })
    steps = apply(steps, 'run.updated', {
      runId: 'run-1', status: 'paused', at: 50,
    })

    expect(steps.map((step) => [step.id, step.status, step.startedAt, step.completedAt])).toEqual([
      ['failed', 'failed', 10, 20],
      ['rejected', 'rejected', 30, 30],
      ['cancelled', 'cancelled', 40, 50],
    ])
  })

  it('keeps complete and Lite presets presentation-only', () => {
    const root = createEmptySession('root')
    root.executionSteps = expectedSteps.map((step) => ({ ...step }))
    const before = structuredClone(root)

    expect(FULL_EXECUTION_PRESENTATION).toEqual({
      stream: 'full', content: 'full', toolDetail: 'full', thinking: 'full',
    })
    expect(LITE_EXECUTION_PRESENTATION).toEqual({
      stream: 'final-only', content: 'lazy', toolDetail: 'name-only', thinking: 'lazy',
    })
    selectExecutionReadModel({ rootChatId: 'root', sessionsById: { root } })
    expect(root).toEqual(before)
  })
})
