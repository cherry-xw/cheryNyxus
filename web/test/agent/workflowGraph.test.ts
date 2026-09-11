import { describe, expect, it } from 'vitest'
import type {
  WorkflowHistoryResponse,
  WorkflowOccurrence,
  WorkflowStepEvent,
  WorkflowUpdated,
} from '@chery/protocol'
import type {
  ConversationBranchSummary,
  RootTimelineSnapshot,
  TimelineNode,
} from '../../src/services/agentApi'
import { topologyMatrixSnapshot } from '../fixtures/executionGraphFixtures'
import {
  WORKFLOW_GRAPH_LAYOUT,
  projectWorkflowGraph,
  resolveWorkflowGraphSelection,
  type WorkflowGraphNodeData,
  type WorkflowGraphProjection,
} from '../../src/features/agent/workbench/runtime-diagram/graphModel'
import { presentResultNode } from '../../src/features/agent/workbench/runtime-diagram/resultTreePresentation'
import {
  applyWorkflowUpdate,
  buildWorkflowReplayState,
  installWorkflowSnapshot,
  workflowReplayLength,
  type WorkflowClientState,
} from '../../src/features/agent/workbench/runtime-diagram/workflowState'

function occurrence(
  occurrenceId: string,
  overrides: Partial<WorkflowOccurrence> = {},
): WorkflowOccurrence {
  return {
    occurrenceId,
    rootChatId: 'root',
    chatId: 'root',
    contextStageId: 'root:start',
    kind: 'model',
    label: `步骤 ${occurrenceId}`,
    status: 'succeeded',
    anchors: [],
    startedAt: 100,
    updatedAt: 101,
    endedAt: 101,
    firstSequence: 1,
    lastSequence: 2,
    orderQuality: 'exact',
    ...overrides,
  }
}

function event(
  eventId: string,
  sequence: number,
  overrides: Partial<WorkflowStepEvent> = {},
): WorkflowStepEvent {
  return {
    eventId,
    occurrenceId: 'occ-state',
    rootChatId: 'root',
    chatId: 'root',
    sequence,
    revision: sequence,
    eventKind: 'status',
    kind: 'model',
    label: '模型交互',
    contextStageId: 'root:start',
    at: 100 + sequence,
    orderQuality: 'exact',
    ...overrides,
  }
}

function workflow(occurrences: WorkflowOccurrence[]): WorkflowClientState {
  return {
    rootChatId: 'root',
    revision: 4,
    upperSequence: 20,
    occurrences: Object.fromEntries(occurrences.map((item) => [item.occurrenceId, item])),
    recentEvents: [],
    gaps: [],
    hasEarlier: false,
    historyComplete: true,
  }
}

function branch(
  branchId: string,
  chatId: string,
  kind: ConversationBranchSummary['kind'],
  createdAt: number,
): ConversationBranchSummary {
  return { branchId, chatId, kind, createdAt, taskId: 'task' }
}

function contentNode(
  id: string,
  sourceChatId: string,
  branchId: string | undefined,
  createdAt: number,
  callId: string,
): TimelineNode {
  return {
    id,
    rootChatId: 'root',
    sourceChatId,
    kind: 'message',
    actor: { kind: 'agent', chatId: sourceChatId, roleType: '执行 Agent' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: `内容 ${id}`,
    toolCalls: [
      {
        callId,
        index: 0,
        name: `工具 ${callId}`,
        arguments: '{}',
        status: 'completed',
      },
    ],
    orderKey: createdAt,
    createdAt,
    updatedAt: createdAt,
    status: 'committed',
    taskId: 'task',
    ...(branchId ? { branchId } : {}),
  }
}

function timeline(activeBranchId = 'main', reverseBranches = false): RootTimelineSnapshot {
  const branches = [
    branch('main', 'root', 'original', 10),
    branch('alternate', 'alternate-chat', 'continuation', 20),
    branch('detail', 'detail-chat', 'detail', 30),
  ]
  return {
    rootChatId: 'root',
    taskId: 'task',
    activeBranchId,
    branches: reverseBranches ? branches.reverse() : branches,
    view: 'tree',
    revision: 8,
    nodes: [
      contentNode('root-message', 'root', 'main', 100, 'root-call'),
      contentNode('alternate-message', 'alternate-chat', 'alternate', 110, 'alternate-call'),
      contentNode('detail-message', 'detail-chat', 'detail', 120, 'detail-call'),
      contentNode('child-message', 'child-chat', undefined, 130, 'child-call'),
    ],
    edges: [
      {
        id: 'explicit-branch-edge',
        rootChatId: 'root',
        fromNodeId: 'root-message',
        toNodeId: 'alternate-message',
        kind: 'fork-continuation',
        orderKey: 1,
        sourceChatId: 'root',
        targetChatId: 'alternate-chat',
        taskId: 'task',
        branchId: 'alternate',
      },
    ],
    activeRuns: [
      { rootChatId: 'root', chatId: 'root', runId: 'run-root', status: 'running' },
      {
        rootChatId: 'root',
        chatId: 'alternate-chat',
        runId: 'run-alternate',
        status: 'waiting',
      },
      { rootChatId: 'root', chatId: 'child-chat', runId: 'run-child', status: 'running' },
    ],
    pendingInputs: [],
    generations: [],
    capturedEventSeq: 12,
  }
}

function graphOccurrences(): WorkflowOccurrence[] {
  return [
    occurrence('root-occurrence', {
      branchId: 'main',
      anchors: [
        { kind: 'message', id: 'root-message', chatId: 'root' },
        { kind: 'tool-call', id: 'root-call', chatId: 'root' },
      ],
      firstSequence: 1,
      lastSequence: 2,
    }),
    occurrence('alternate-occurrence', {
      chatId: 'alternate-chat',
      branchId: 'alternate',
      status: 'waiting',
      waitReason: 'approval',
      endedAt: undefined,
      causeOccurrenceId: 'root-occurrence',
      anchors: [{ kind: 'message', id: 'missing-message', chatId: 'alternate-chat' }],
      startedAt: 111,
      updatedAt: 112,
      firstSequence: 3,
      lastSequence: 4,
    }),
    occurrence('detail-occurrence', {
      chatId: 'detail-chat',
      branchId: 'detail',
      status: 'running',
      endedAt: undefined,
      startedAt: 121,
      updatedAt: 122,
      firstSequence: 5,
      lastSequence: 6,
    }),
    occurrence('child-occurrence', {
      chatId: 'child-chat',
      status: 'running',
      endedAt: undefined,
      startedAt: 131,
      updatedAt: 132,
      firstSequence: 7,
      lastSequence: 20,
    }),
  ]
}

function headerData(projection: WorkflowGraphProjection, id: string) {
  const data = projection.nodes.find((node) => node.id === id)?.data as
    Extract<WorkflowGraphNodeData, { kind: 'header' }> | undefined
  if (!data || data.kind !== 'header') throw new Error(`Missing header ${id}`)
  return data
}

describe('workflow occurrence reducer', () => {
  it('requires continuous revisions and sequence coverage, including explicit gaps', () => {
    const lease = { subscriptionId: 'subscription', streamId: 'stream' }
    const initial = installWorkflowSnapshot({
      rootChatId: 'root',
      revision: 1,
      upperSequence: 1,
      active: [occurrence('occ-state', { status: 'running', endedAt: undefined })],
      recentEvents: [],
      gaps: [],
      hasEarlier: false,
      historyComplete: true,
    })
    const mismatch: WorkflowUpdated = {
      ...lease,
      baseRevision: 0,
      revision: 2,
      events: [],
    }
    expect(applyWorkflowUpdate(initial, mismatch, lease)).toEqual({
      kind: 'reload',
      reason: 'revision',
    })

    const success = applyWorkflowUpdate(
      initial,
      {
        ...lease,
        baseRevision: 1,
        revision: 2,
        events: [event('terminal', 2, { status: 'succeeded' })],
      },
      lease,
    )
    expect(success.kind).toBe('applied')
    if (success.kind !== 'applied') return

    const gap = applyWorkflowUpdate(
      success.state,
      {
        ...lease,
        baseRevision: 2,
        revision: 3,
        gaps: [
          {
            gapId: 'gap',
            rootChatId: 'root',
            fromSequence: 3,
            toSequence: 5,
            reason: 'write-failed',
          },
        ],
      },
      lease,
    )
    expect(gap.kind).toBe('applied')
    if (gap.kind === 'applied') {
      expect(gap.state.upperSequence).toBe(5)
      expect(gap.state.historyComplete).toBe(false)
    }
  })

  it('never flips a terminal occurrence but still accepts a later explicit anchor', () => {
    const lease = { subscriptionId: 'subscription', streamId: 'stream' }
    const initial = installWorkflowSnapshot({
      rootChatId: 'root',
      revision: 1,
      upperSequence: 1,
      active: [],
      recentEvents: [event('terminal', 1, { status: 'succeeded' })],
      gaps: [],
      hasEarlier: false,
      historyComplete: true,
    })
    const decision = applyWorkflowUpdate(
      initial,
      {
        ...lease,
        baseRevision: 1,
        revision: 2,
        events: [
          event('late-update', 2, {
            eventKind: 'anchor-added',
            status: 'running',
            anchor: { kind: 'message', id: 'message', chatId: 'root' },
          }),
        ],
      },
      lease,
    )
    expect(decision.kind).toBe('applied')
    if (decision.kind === 'applied') {
      expect(decision.state.occurrences['occ-state']?.status).toBe('succeeded')
      expect(decision.state.occurrences['occ-state']?.anchors).toEqual([
        { kind: 'message', id: 'message', chatId: 'root' },
      ])
    }
  })

  it('builds detached fixed replay frames for event, occurrence and legacy histories', () => {
    const base: WorkflowHistoryResponse = {
      chatId: 'root',
      contextStageId: 'root:start',
      boundary: 9,
      stages: [{ id: 'root:start', label: 'start', quality: 'exact' }],
      facts: [],
      complete: true,
      historyComplete: true,
      resources: { loadedSkillsComplete: true },
    }
    const eventHistory: WorkflowHistoryResponse = {
      ...base,
      revision: 2,
      upperSequence: 2,
      events: [
        event('event-running', 1, { status: 'running' }),
        event('event-done', 2, { status: 'succeeded' }),
      ],
      gaps: [],
    }
    const firstEventFrame = buildWorkflowReplayState(eventHistory, 0)
    const finalEventFrame = buildWorkflowReplayState(eventHistory, 1)
    expect(workflowReplayLength(eventHistory)).toBe(2)
    expect(firstEventFrame.upperSequence).toBe(1)
    expect(firstEventFrame.occurrences['occ-state']?.status).toBe('running')
    expect(finalEventFrame.occurrences['occ-state']?.status).toBe('succeeded')
    expect(eventHistory.events?.[0]?.status).toBe('running')

    const occurrenceHistory: WorkflowHistoryResponse = {
      ...base,
      occurrences: [
        occurrence('first'),
        occurrence('second', { firstSequence: 3, lastSequence: 4 }),
      ],
      gaps: [],
    }
    const occurrenceFrame = buildWorkflowReplayState(occurrenceHistory, 0)
    expect(workflowReplayLength(occurrenceHistory)).toBe(2)
    expect(Object.keys(occurrenceFrame.occurrences)).toEqual(['first'])

    const legacyHistory: WorkflowHistoryResponse = {
      ...base,
      historyComplete: false,
      facts: [
        {
          id: 'legacy',
          nodeId: 'model',
          label: 'model',
          status: 'completed',
          orderKey: 1,
          orderQuality: 'reconstructed',
        },
      ],
    }
    const legacyFrame = buildWorkflowReplayState(legacyHistory, 0)
    expect(workflowReplayLength(legacyHistory)).toBe(1)
    expect(Object.values(legacyFrame.occurrences)[0]).toMatchObject({
      label: '旧记录 · 细节未记录',
      status: 'unknown',
      orderQuality: 'reconstructed',
    })
    expect(legacyFrame.historyComplete).toBe(false)
  })
})

describe('unified workflow graph projection', () => {
  it('uses stable content IDs and keeps missing anchors out of the result tree', () => {
    const input = workflow(graphOccurrences())
    const first = projectWorkflowGraph(input, timeline())
    const second = projectWorkflowGraph(input, timeline())
    expect(first.nodes.map((node) => node.id)).toEqual(second.nodes.map((node) => node.id))
    expect(first.edges.map((edge) => edge.id)).toEqual(second.edges.map((edge) => edge.id))
    expect(first.nodes.some((node) => node.data.kind === 'occurrence')).toBe(false)
    expect(first.nodes.some((node) => node.data.kind === 'unresolved')).toBe(false)
    const missing = first.scene.headerFlow.headers
      .flatMap((header) => header.steps)
      .find((step) => step.occurrenceId === 'alternate-occurrence')?.contentTarget
    expect(missing).toMatchObject({ status: 'unavailable', reason: 'missing-anchor' })
    expect(first.scene.resultTree.edges.every((edge) => edge.semantic === 'fact')).toBe(true)
    expect(first.scene.edges.find((edge) => edge.id === 'head:main')?.semantic).toBe('template')

    const changedTimeline = timeline()
    changedTimeline.nodes[0]!.content = '正文增量不得改变结果树几何'
    const changed = projectWorkflowGraph(input, changedTimeline)
    const contentPositions = (projection: WorkflowGraphProjection) =>
      Object.fromEntries(
        projection.nodes
          .filter((node) => node.data.kind === 'content')
          .map((node) => [node.id, node.position]),
      )
    expect(contentPositions(changed)).toEqual(contentPositions(first))

    const factEdges = first.edges.filter((edge) => edge.data?.semantic === 'fact')
    expect(factEdges.length).toBeGreaterThan(0)
    expect(
      factEdges.every(
        (edge) =>
          edge.type === 'result' &&
          edge.sourceHandle === 'result-out' &&
          edge.targetHandle === 'result-in',
      ),
    ).toBe(true)
    const waitingNode = first.nodes.find((node) => node.id === 'content:alternate-message')
    expect(waitingNode?.data.kind).toBe('content')
    if (waitingNode?.data.kind === 'content') {
      const waitingPresentation = presentResultNode(
        {
          ...waitingNode.data.node,
          activeRuns: [timeline().activeRuns.find((run) => run.status === 'waiting')!],
        },
        waitingNode.data.title,
        waitingNode.data.preview,
      )
      expect(waitingPresentation).toMatchObject({
        statusText: '等待继续',
        statusTone: 'waiting',
      })
    }
  })

  it('projects distinguishable result kinds and advances every fact edge to a later column', () => {
    const projection = projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'participant')
    const contentNodes = projection.nodes.filter(
      (node): node is typeof node & { data: Extract<WorkflowGraphNodeData, { kind: 'content' }> } =>
        node.data.kind === 'content',
    )
    const expectedKind = {
      input: 'input',
      message: 'message',
      'tool-batch': 'tool',
      dispatch: 'branch',
      spawn: 'branch',
      return: 'return',
      fold: 'group',
      pack: 'group',
      system: 'system',
      unknown: 'system',
    } as const

    expect(contentNodes.some((node) => node.data.presentation.visualKind === 'branch')).toBe(true)
    expect(contentNodes.some((node) => node.data.presentation.visualKind === 'return')).toBe(true)
    for (const node of contentNodes) {
      const kind = node.data.node.kind
      if (kind === 'start') continue
      const visualKind =
        kind === 'message' && node.data.node.actor.kind === 'user' ? 'input' : expectedKind[kind]
      expect(node.data.presentation.visualKind).toBe(visualKind)
      expect(node.data.presentation.ariaLabel).toContain(node.data.title)
      expect(node.data.presentation.statusText.length).toBeGreaterThan(0)
    }

    const positions = new Map(contentNodes.map((node) => [node.id, node.position]))
    const factEdges = projection.edges.filter((edge) => edge.data?.semantic === 'fact')
    for (const edge of factEdges) {
      expect(positions.get(edge.target)!.x).toBeGreaterThan(positions.get(edge.source)!.x)
    }
    expect(factEdges.some((edge) => edge.data?.relationLabel === '派发')).toBe(true)
  })

  it('isolates equal anchor IDs by chat and opens the exact anchored tool call', () => {
    const snapshot = timeline()
    const rootNode = snapshot.nodes.find((node) => node.id === 'root-message')!
    const alternateNode = snapshot.nodes.find((node) => node.id === 'alternate-message')!
    rootNode.toolCalls![0]!.callId = 'shared-call'
    alternateNode.toolCalls![0]!.callId = 'shared-call'
    const projection = projectWorkflowGraph(
      workflow([
        occurrence('root-tool', {
          branchId: 'main',
          anchors: [{ kind: 'tool-call', id: 'shared-call', chatId: 'root' }],
        }),
        occurrence('alternate-tool', {
          chatId: 'alternate-chat',
          branchId: 'alternate',
          anchors: [{ kind: 'tool-call', id: 'shared-call', chatId: 'alternate-chat' }],
          firstSequence: 3,
          lastSequence: 4,
        }),
      ]),
      snapshot,
    )

    expect(
      resolveWorkflowGraphSelection(projection, {
        nodeId: 'shared-call',
        sourceChatId: 'root',
      }),
    ).toMatchObject({
      status: 'available',
      graphNodeId: 'content:root-message',
      callId: 'shared-call',
    })
    expect(
      resolveWorkflowGraphSelection(projection, {
        nodeId: 'shared-call',
        sourceChatId: 'alternate-chat',
      }),
    ).toMatchObject({
      status: 'available',
      graphNodeId: 'content:alternate-message',
      callId: 'shared-call',
    })
    expect(
      resolveWorkflowGraphSelection(projection, {
        nodeId: 'shared-call',
        sourceChatId: 'missing-chat',
      }),
    ).toMatchObject({ status: 'unavailable', reason: 'chat-mismatch' })
  })

  it('elects one full eligible header and keeps detail and descendant headers compact', () => {
    const projection = projectWorkflowGraph(workflow(graphOccurrences()), timeline())
    const headers = projection.nodes.filter((node) => node.data.kind === 'header')
    expect(
      headers.filter((node) => node.data.kind === 'header' && node.data.mode === 'full'),
    ).toHaveLength(1)
    expect(headerData(projection, 'header:main').mode).toBe('full')
    expect(headerData(projection, 'header:detail').mode).toBe('compact')
    expect(headerData(projection, 'header:agent:child-chat').mode).toBe('compact')
    expect(
      headerData(projection, 'header:main').sections.flatMap((section) => section.kinds),
    ).toContain('tool-authorization')
    expect(projection.nodes.filter((node) => node.data.kind === 'occurrence')).toHaveLength(0)
    expect(projection.scene.headerFlow.activeStepId).toBe('header-step:child-occurrence')
    expect(projection.activeOccurrenceId).toBe('header:agent:child-chat')

    const legacy = projectWorkflowGraph(
      workflow([occurrence('legacy', { status: 'running', endedAt: undefined })]),
      undefined,
    )
    expect(headerData(legacy, 'header:agent:root').mode).toBe('full')
  })

  it('changes only header form on branch activation and ignores incoming branch array order', () => {
    const input = workflow(graphOccurrences())
    const main = projectWorkflowGraph(input, timeline('main'))
    const alternate = projectWorkflowGraph(input, timeline('alternate', true))
    const historyPositions = (projection: WorkflowGraphProjection) =>
      Object.fromEntries(
        projection.nodes
          .filter((node) => node.data.kind === 'content')
          .map((node) => [node.id, node.position]),
      )
    expect(historyPositions(alternate)).toEqual(historyPositions(main))
    expect(headerData(main, 'header:main').mode).toBe('full')
    expect(headerData(main, 'header:alternate').mode).toBe('compact')
    expect(headerData(alternate, 'header:main').mode).toBe('compact')
    expect(headerData(alternate, 'header:alternate').mode).toBe('full')
  })

  it('keeps every node rectangle separate and isolates tool calls by lane', () => {
    const projection = projectWorkflowGraph(workflow(graphOccurrences()), timeline())
    const overlaps: string[] = []
    const topLevel = projection.nodes.filter((node) => !node.parentNode)
    for (const [index, left] of topLevel.entries()) {
      for (const right of topLevel.slice(index + 1)) {
        const leftWidth = Number(left.width ?? 0)
        const leftHeight = Number(left.height ?? 0)
        const rightWidth = Number(right.width ?? 0)
        const rightHeight = Number(right.height ?? 0)
        const separate =
          left.position.x + leftWidth <= right.position.x ||
          right.position.x + rightWidth <= left.position.x ||
          left.position.y + leftHeight <= right.position.y ||
          right.position.y + rightHeight <= left.position.y
        if (!separate) overlaps.push(`${left.id} / ${right.id}`)
      }
    }
    expect(overlaps).toEqual([])
    expect(WORKFLOW_GRAPH_LAYOUT.fullHeaderHeight).toBeGreaterThan(WORKFLOW_GRAPH_LAYOUT.laneStride)
    expect(
      projection.scene.headerFlow.headers
        .find((header) => header.id === 'header:main')
        ?.calls.map((call) => call.id),
    ).toEqual(['root-call'])
    expect(
      projection.scene.headerFlow.headers
        .find((header) => header.id === 'header:alternate')
        ?.calls.map((call) => call.id),
    ).toEqual(['alternate-call'])
    expect(
      projection.scene.headerFlow.headers
        .find((header) => header.id === 'header:agent:child-chat')
        ?.calls.map((call) => call.id),
    ).toEqual(['child-call'])
  })
})
