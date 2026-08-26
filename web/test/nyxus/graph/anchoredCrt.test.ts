import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot } from '../../../src/services/agentApi'
import type { ChatSession } from '../../../src/stores/chats/types'
import { createEmptySession } from '../../../src/stores/chats/model/hydration'
import {
  createRootTransientState,
  effectiveRootLiveState,
} from '../../../src/stores/chats/read-model/rootTimeline'
import {
  projectActiveTurnNodes,
  projectPersistentExecutionGraph,
  type ExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import { projectFoldExecutionGraph } from '../../../src/features/pets/nyxus/graph/foldProjection'
import { buildDefaultNodePopovers } from '../../../src/features/pets/nyxus/graph/nodePopoverModel'
import {
  buildRunCrtModels,
  effectiveRunFacts,
  visibleCrtAnchorId,
} from '../../../src/features/pets/nyxus/graph/crtModel'
import {
  layoutAnchoredCrts,
  layoutCrtWindowsBesideAnchors,
  selectVisibleCrtIds,
  type CrtPlacement,
} from '../../../src/features/pets/nyxus/graph/crtLayout'

interface Fixture {
  source: string
  snapshot: RootTimelineSnapshot
  sessions: Record<string, ChatSession>
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url))
}

function sourcePath(name: string): string {
  return fileURLToPath(new URL(`../../../src/${name}`, import.meta.url))
}

function overlap(a: CrtPlacement, b: CrtPlacement): boolean {
  return !(
    a.left + a.panel.width <= b.left ||
    b.left + b.panel.width <= a.left ||
    a.top + a.panel.height <= b.top ||
    b.top + b.panel.height <= a.top
  )
}

describe('anchored CRT model', () => {
  it('renders a CRT through the component data path when root transient hand-off is empty', () => {
    const session = createEmptySession('root')
    session.activeTurns = [
      {
        turnId: 'turn:live',
        runId: 'run:live',
        messageId: 'message:live',
        thinking: 'streaming trace',
        content: '',
        status: 'running',
        createdAt: 2,
      },
    ]
    session.activeRun = { runId: 'run:live', status: 'running' }
    const liveState = effectiveRootLiveState('root', createRootTransientState(), {
      root: session,
    })
    const runs = effectiveRunFacts('root', [], liveState.activeRuns)
    const persistent = projectPersistentExecutionGraph({
      rootChatId: 'root',
      nodes: [],
      edges: [],
      activeRuns: runs,
    })
    const graph = projectActiveTurnNodes(persistent, liveState.activeTurns, runs)

    expect(
      buildRunCrtModels({
        rootChatId: 'root',
        runs,
        activeTurns: liveState.activeTurns,
        canonicalNodes: persistent.nodes,
        visibleNodes: graph.nodes,
        sessionsById: { root: session },
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'crt:root:run:live:message:live',
        anchorNodeId: 'message:live',
        thinking: 'streaming trace',
      }),
    ])
  })

  it('does not render a CRT when its run is no longer running', () => {
    const session = createEmptySession('root')
    session.activeTurns = [
      {
        turnId: 'turn:live',
        runId: 'run:live',
        messageId: 'message:live',
        thinking: '',
        content: 'last streamed output',
        status: 'running',
        createdAt: 2,
      },
    ]
    const node = {
      id: 'message:live',
      kind: 'message',
      sourceChatId: 'root',
      status: 'committed',
      orderKey: 2,
    } as ExecutionNode

    for (const status of ['waiting', 'paused', 'completed', 'failed'] as const) {
      expect(
        buildRunCrtModels({
          rootChatId: 'root',
          runs: [{ rootChatId: 'root', chatId: 'root', runId: 'run:live', status }],
          activeTurns: session.activeTurns,
          canonicalNodes: [node],
          visibleNodes: [node],
          sessionsById: { root: session },
        }),
      ).toEqual([])
    }

    expect(
      buildRunCrtModels({
        rootChatId: 'root',
        runs: [
          { rootChatId: 'root', chatId: 'root', runId: 'run:live', status: 'running' },
        ],
        authoritativeRuns: [
          { rootChatId: 'root', chatId: 'root', runId: 'run:live', status: 'completed' },
        ],
        activeTurns: session.activeTurns,
        canonicalNodes: [node],
        visibleNodes: [node],
        sessionsById: { root: session },
      }),
    ).toEqual([])
  })

  it('keeps a pending approval popover open and its node expanded', () => {
    const session = createEmptySession('root')
    session.interaction.approval = {
      approvalId: 'call:second',
      senseName: 'write_file',
      waitTime: 60_000,
      createdAt: 1,
    }
    const batch = {
      id: 'batch:approval',
      batchId: 'batch:approval',
      rootChatId: 'root',
      sourceChatId: 'root',
      sourceMessageId: 'assistant:approval',
      kind: 'tool-batch' as const,
      actor: { kind: 'agent' as const, chatId: 'root' },
      direction: 'internal' as const,
      visibility: 'detail' as const,
      content: '',
      toolCalls: [
        { callId: 'call:first', index: 0, name: 'read_file', arguments: '{}', status: 'accepted' as const },
        { callId: 'call:second', index: 1, name: 'write_file', arguments: '{}', status: 'pending' as const },
      ],
      orderKey: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'committed' as const,
    }
    const graphFor = () =>
      projectPersistentExecutionGraph({ rootChatId: 'root', nodes: [batch], edges: [], activeRuns: [] })

    expect(buildDefaultNodePopovers(graphFor().nodes, { root: session })[0]).toMatchObject({
      anchorNodeId: 'batch:approval',
      displayNodeId: 'batch:approval',
      selectedCallId: 'call:second',
    })

    batch.toolCalls[0]!.status = 'completed'
    expect(buildDefaultNodePopovers(graphFor().nodes, { root: session })[0]).toMatchObject({
      anchorNodeId: 'batch:approval',
      displayNodeId: 'batch:approval',
      selectedCallId: 'call:second',
    })
  })

  it('treats transient run state as authoritative while preserving matching durable anchors', () => {
    expect(effectiveRunFacts('root', [], [{ chatId: 'root', runId: 'new', status: 'running' }]))
      .toEqual([
        {
          rootChatId: 'root',
          chatId: 'root',
          runId: 'new',
          status: 'running',
        },
      ])

    expect(
      effectiveRunFacts(
        'root',
        [
          {
            rootChatId: 'root',
            chatId: 'root',
            runId: 'new',
            status: 'running',
            nodeId: 'message:new',
            batchId: 'batch:new',
          },
        ],
        [{ chatId: 'root', runId: 'new', state: 'waiting' }],
      ),
    ).toEqual([
      {
        rootChatId: 'root',
        chatId: 'root',
        runId: 'new',
        status: 'waiting',
        nodeId: 'message:new',
        batchId: 'batch:new',
      },
    ])
  })

  it('does not resurrect stale finished snapshot runs after the transient plane clears', () => {
    expect(
      effectiveRunFacts(
        'root',
        [
          { rootChatId: 'root', chatId: 'root', runId: 'old', status: 'completed' },
          { rootChatId: 'root', chatId: 'child', runId: 'failed', status: 'failed' },
        ],
        [],
      ),
    ).toEqual([])

    expect(
      effectiveRunFacts(
        'root',
        [{ rootChatId: 'root', chatId: 'root', runId: 'completed', status: 'completed' }],
        [{ chatId: 'root', runId: 'completed', status: 'running' }],
        [
          {
            chatId: 'root',
            turnId: 'turn:stale',
            runId: 'completed',
            messageId: 'message:stale',
            thinking: 'stale',
            content: 'stale output',
            status: 'running',
          },
        ],
      ),
    ).toEqual([])

    expect(
      effectiveRunFacts(
        'root',
        [{ rootChatId: 'root', chatId: 'root', runId: 'paused', status: 'paused' }],
        [{ chatId: 'root', runId: 'paused', status: 'completed' }],
      ),
    ).toEqual([])
  })

  it('keeps durable paused runs but replaces an older run for the same chat', () => {
    expect(
      effectiveRunFacts(
        'root',
        [
          { rootChatId: 'root', chatId: 'root', runId: 'paused', status: 'paused' },
          { rootChatId: 'root', chatId: 'child', runId: 'child-paused', status: 'paused' },
        ],
        [{ chatId: 'root', runId: 'replacement', status: 'running' }],
      ),
    ).toEqual([
      {
        rootChatId: 'root',
        chatId: 'child',
        runId: 'child-paused',
        status: 'paused',
      },
      {
        rootChatId: 'root',
        chatId: 'root',
        runId: 'replacement',
        status: 'running',
      },
    ])
  })

  it('shows the first live response on its pending input before a canonical node exists', () => {
    const session = createEmptySession('new-root')
    session.activeTurns = [
      {
        chatId: 'new-root',
        turnId: 'turn:first',
        runId: 'run:first',
        messageId: 'assistant:first',
        thinking: 'planning',
        content: 'first live delta',
        status: 'running',
      },
    ]
    const start = {
      id: 'start:new-root',
      kind: 'start',
      rootChatId: 'new-root',
      sourceChatId: 'new-root',
      activeRuns: [],
      status: 'transient',
      orderSlot: 'start',
      orderKey: null,
    } as ExecutionNode
    const pending = {
      ...start,
      id: 'user:first',
      kind: 'input',
      orderSlot: 'transient',
      inputState: 'pending',
    } as ExecutionNode

    const models = buildRunCrtModels({
      rootChatId: 'new-root',
      runs: [
        {
          rootChatId: 'new-root',
          chatId: 'new-root',
          runId: 'run:first',
          status: 'running',
        },
      ],
      canonicalNodes: [start],
      visibleNodes: [start, pending],
      sessionsById: { 'new-root': session },
    })

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'crt:new-root:run:first:assistant:first',
      anchorNodeId: 'user:first',
      content: 'first live delta',
      thinking: 'planning',
      status: 'running',
    })
  })

  it('anchors a later live turn to its transient response node instead of the previous fact', () => {
    const session = createEmptySession('root')
    session.activeTurns = [
      {
        chatId: 'root',
        turnId: 'turn:next',
        runId: 'run:next',
        messageId: 'assistant:next',
        thinking: '',
        content: 'new delta',
        status: 'running',
      },
    ]
    const previous = {
      id: 'assistant:previous',
      kind: 'message',
      rootChatId: 'root',
      sourceChatId: 'root',
      activeRuns: [],
      status: 'committed',
      orderSlot: 'persistent',
      orderKey: 1,
    } as ExecutionNode
    const live = {
      ...previous,
      id: 'assistant:next',
      status: 'transient',
      orderSlot: 'transient',
      orderKey: null,
    } as ExecutionNode

    expect(
      buildRunCrtModels({
        rootChatId: 'root',
        runs: [{ rootChatId: 'root', chatId: 'root', runId: 'run:next', status: 'running' }],
        canonicalNodes: [previous],
        visibleNodes: [previous, live],
        sessionsById: { root: session },
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'crt:root:run:next:assistant:next',
        canonicalNodeId: 'assistant:next',
        anchorNodeId: 'assistant:next',
        content: 'new delta',
      }),
    ])
  })

  it('follows live node creation, canonical takeover, completion fold and CRT destruction', () => {
    const session = createEmptySession('root')
    const turn = {
      chatId: 'root',
      turnId: 'turn:live',
      runId: 'run:live',
      messageId: 'assistant:live',
      thinking: '',
      content: 'streaming',
      status: 'running' as const,
      createdAt: 2,
    }
    session.activeTurns = [turn]
    const oldFact = {
      id: 'assistant:old',
      rootChatId: 'root',
      sourceChatId: 'root',
      sourceMessageId: 'assistant:old',
      kind: 'message' as const,
      actor: { kind: 'agent' as const, chatId: 'root' },
      direction: 'agent-to-user' as const,
      visibility: 'conversation' as const,
      content: 'old',
      orderKey: 1,
      createdAt: 1,
      updatedAt: 1,
      status: 'committed' as const,
    }
    const liveFact = {
      ...oldFact,
      id: 'assistant:live',
      sourceMessageId: 'assistant:live',
      content: 'sealed',
      orderKey: 2,
      createdAt: 2,
      updatedAt: 2,
    }
    const run = {
      rootChatId: 'root',
      chatId: 'root',
      runId: 'run:live',
      status: 'running' as const,
      nodeId: 'assistant:live',
    }

    const beforeCanonical = projectActiveTurnNodes(
      projectPersistentExecutionGraph({
        rootChatId: 'root',
        nodes: [oldFact],
        edges: [],
        activeRuns: [run],
      }),
      [turn],
      [run],
    )
    const liveCards = buildRunCrtModels({
      rootChatId: 'root',
      runs: [run],
      canonicalNodes: beforeCanonical.nodes.filter((node) => node.orderSlot === 'persistent'),
      visibleNodes: beforeCanonical.nodes,
      sessionsById: { root: session },
    })
    expect(beforeCanonical.nodes.find((node) => node.id === 'assistant:live')?.orderSlot).toBe(
      'transient',
    )
    expect(liveCards).toEqual([
      expect.objectContaining({ anchorNodeId: 'assistant:live', content: 'streaming' }),
    ])

    const canonical = projectPersistentExecutionGraph({
      rootChatId: 'root',
      nodes: [oldFact, liveFact],
      edges: [],
      activeRuns: [run],
    })
    expect(projectFoldExecutionGraph(canonical).ranges).toEqual([])
    expect(
      buildRunCrtModels({
        rootChatId: 'root',
        runs: [run],
        canonicalNodes: canonical.nodes,
        visibleNodes: canonical.nodes,
        sessionsById: { root: session },
      })[0],
    ).toMatchObject({ id: liveCards[0]?.id, anchorNodeId: 'assistant:live' })

    session.activeTurns = []
    const completed = projectFoldExecutionGraph(
      projectPersistentExecutionGraph({
        rootChatId: 'root',
        nodes: [oldFact, liveFact],
        edges: [],
        activeRuns: [],
      }),
    )
    expect(completed.ranges).toEqual([])
    expect(completed.graph.nodes.some((node) => node.id === 'assistant:old')).toBe(true)
    expect(
      buildRunCrtModels({
        rootChatId: 'root',
        runs: [],
        canonicalNodes: completed.graph.nodes,
        visibleNodes: completed.graph.nodes,
        sessionsById: { root: session },
      }),
    ).toEqual([])
  })

  it('keeps an independent CRT identity for every active node in the same run', () => {
    const session = createEmptySession('root')
    const firstTurn = {
      chatId: 'root',
      turnId: 'assistant:first',
      runId: 'run:shared',
      messageId: 'assistant:first',
      thinking: '',
      content: 'first',
      status: 'running' as const,
      createdAt: 1,
    }
    const secondTurn = {
      ...firstTurn,
      turnId: 'assistant:second',
      messageId: 'assistant:second',
      content: 'second',
      createdAt: 2,
    }
    session.activeTurns = [firstTurn, secondTurn]
    const node = (id: string, orderKey: number) =>
      ({
        id,
        kind: 'message',
        rootChatId: 'root',
        sourceChatId: 'root',
        content: id,
        status: 'transient',
        orderSlot: 'transient',
        orderKey,
      }) as ExecutionNode
    const visibleNodes = [node('assistant:first', 1), node('assistant:second', 2)]
    const run = {
      rootChatId: 'root',
      chatId: 'root',
      runId: 'run:shared',
      status: 'running' as const,
    }

    const both = buildRunCrtModels({
      rootChatId: 'root',
      runs: [run],
      canonicalNodes: [],
      visibleNodes,
      sessionsById: { root: session },
    })
    expect(both.map((card) => [card.id, card.anchorNodeId])).toEqual([
      ['crt:root:run:shared:assistant:first', 'assistant:first'],
      ['crt:root:run:shared:assistant:second', 'assistant:second'],
    ])

    session.activeTurns = [secondTurn]
    expect(
      buildRunCrtModels({
        rootChatId: 'root',
        runs: [run],
        canonicalNodes: [],
        visibleNodes,
        sessionsById: { root: session },
      }).map((card) => card.id),
    ).toEqual(['crt:root:run:shared:assistant:second'])
  })

  it('projects root and spawned child turns as separate CRTs even when child run.updated is late', () => {
    const rootSession = createEmptySession('root')
    const childSession = createEmptySession('child')
    const persistent = projectPersistentExecutionGraph({
      rootChatId: 'root',
      nodes: [
        {
          id: 'root:batch',
          rootChatId: 'root',
          sourceChatId: 'root',
          kind: 'tool-batch',
          actor: { kind: 'agent', chatId: 'root' },
          direction: 'internal',
          visibility: 'detail',
          content: 'spawn child',
          orderKey: 1,
          createdAt: 1,
          updatedAt: 1,
          status: 'committed',
        },
        {
          id: 'spawn-target:task:child',
          rootChatId: 'root',
          sourceChatId: 'child',
          kind: 'dispatch',
          actor: { kind: 'agent', chatId: 'root' },
          target: { kind: 'agent', chatId: 'child' },
          direction: 'parent-to-child',
          visibility: 'internal',
          content: 'child task',
          orderKey: 2,
          createdAt: 2,
          updatedAt: 2,
          status: 'committed',
        },
      ],
      edges: [
        {
          id: 'edge:spawn:child',
          rootChatId: 'root',
          fromNodeId: 'root:batch',
          toNodeId: 'spawn-target:task:child',
          kind: 'spawn',
          orderKey: 3,
          sourceChatId: 'root',
          targetChatId: 'child',
        },
      ],
      activeRuns: [],
    })
    const activeTurns = [
      {
        chatId: 'root',
        turnId: 'root:turn',
        runId: 'root:run',
        messageId: 'root:message',
        thinking: '',
        content: 'root stream',
        status: 'running' as const,
        createdAt: 1,
      },
      {
        chatId: 'child',
        turnId: 'child:turn',
        runId: 'child:run',
        messageId: 'child:message',
        thinking: '',
        content: 'child stream',
        status: 'running' as const,
        createdAt: 2,
      },
    ]
    for (const childRunArrived of [false, true]) {
      const runs = effectiveRunFacts(
        'root',
        [],
        [
          { chatId: 'root', runId: 'root:run', status: 'running' },
          ...(childRunArrived
            ? [{ chatId: 'child', runId: 'child:run', status: 'running' as const }]
            : []),
        ],
        activeTurns,
      )
      expect(runs).toContainEqual(
        expect.objectContaining({ chatId: 'child', runId: 'child:run', status: 'running' }),
      )
      const live = projectActiveTurnNodes(persistent, activeTurns, runs)
      const cards = buildRunCrtModels({
        rootChatId: 'root',
        runs: childRunArrived ? runs : runs.filter((run) => run.chatId !== 'child'),
        activeTurns,
        canonicalNodes: persistent.nodes,
        visibleNodes: live.nodes,
        sessionsById: { root: rootSession, child: childSession },
      })

      expect(live.edges).toContainEqual(
        expect.objectContaining({
          from: 'spawn-target:task:child',
          to: 'child:message',
          kind: 'stream',
        }),
      )
      expect(cards.map((card) => [card.id, card.anchorNodeId, card.main])).toEqual([
        ['crt:root:root:run:root:message', 'root:message', true],
        ['crt:child:child:run:child:message', 'child:message', false],
      ])
    }
  })

  it('maps captured active runs to canonical node/batch anchors and keeps patch identity stable', async () => {
    const fixture = JSON.parse(
      await readFile(fixturePath('cp9-real-anchored-crt.json'), 'utf8'),
    ) as Fixture
    expect(fixture.source).toBe('captured-and-redacted')
    const graph = projectPersistentExecutionGraph(fixture.snapshot)
    const first = buildRunCrtModels({
      rootChatId: fixture.snapshot.rootChatId,
      runs: fixture.snapshot.activeRuns,
      canonicalNodes: graph.nodes,
      visibleNodes: graph.nodes,
      sessionsById: fixture.sessions,
    })
    fixture.sessions['root-cp9-real']!.activeTurns[0]!.content += ' PATCH'
    const patched = buildRunCrtModels({
      rootChatId: fixture.snapshot.rootChatId,
      runs: fixture.snapshot.activeRuns,
      canonicalNodes: graph.nodes,
      visibleNodes: graph.nodes,
      sessionsById: fixture.sessions,
    })

    expect(first.map((card) => [card.id, card.anchorNodeId])).toEqual([
      ['crt:root-cp9-real:run:root-live:root-live', 'message:root-live'],
    ])
    expect(first[0]).not.toHaveProperty('approval')
    expect(first[0]).not.toHaveProperty('toolBatch')
    expect(first[0]).toMatchObject({ actionable: false })
    expect(patched[0]?.id).toBe(first[0]?.id)
    expect(patched[0]?.content).toContain('PATCH')
  })

  it('reanchors a canonical run to its Fold and returns no stale anchor after removal', () => {
    const canonical = { id: 'batch:inside' } as ExecutionNode
    const fold = {
      id: 'fold:root:inside',
      fold: { projectionNodes: [canonical] },
    } as ExecutionNode
    expect(visibleCrtAnchorId(canonical.id, [fold])).toBe(fold.id)
    expect(visibleCrtAnchorId(canonical.id, [])).toBeUndefined()
  })
})

describe('CRT anchored layout', () => {
  it('keeps concurrent CRTs beside their nodes and allows overlap', () => {
    const placements = layoutCrtWindowsBesideAnchors(
      [
        {
          id: 'first',
          anchor: { x: 500, y: 700 },
          panel: { width: 360, height: 476 },
          anchorClearance: 34,
          main: true,
          actionable: false,
          order: 1,
          lineTargetOffsetY: 16,
        },
        {
          id: 'second',
          anchor: { x: 500, y: 700 },
          panel: { width: 360, height: 476 },
          anchorClearance: 34,
          main: true,
          actionable: false,
          order: 2,
          lineTargetOffsetY: 16,
        },
      ],
      { width: 1200, height: 800, margin: 12 },
    )

    expect(placements.map(({ left, top, placement }) => ({ left, top, placement }))).toEqual([
      { left: 534, top: 684, placement: 'right' },
      { left: 534, top: 684, placement: 'right' },
    ])
    expect(placements[0]!.top + placements[0]!.panel.height).toBeGreaterThan(800)
    expect(placements[0]!.line.to).toEqual({ x: 534, y: 700 })
  })

  it('uses the left side when a CRT does not fit to the right', () => {
    const [placement] = layoutCrtWindowsBesideAnchors(
      [
        {
          id: 'near-right-edge',
          anchor: { x: 1080, y: 300 },
          panel: { width: 360, height: 300 },
          anchorClearance: 34,
          main: false,
          actionable: false,
          order: 1,
        },
      ],
      { width: 1200, height: 800, margin: 12 },
    )

    expect(placement).toMatchObject({ placement: 'left', left: 686, top: 284 })
    expect(placement!.line.to).toEqual({ x: 1046, y: 300 })
  })

  it('places child branches outward, staggers main cards, avoids collision and stays in bounds', () => {
    const viewport = { width: 1280, height: 800, margin: 12 }
    const placements = layoutAnchoredCrts(
      [
        { id: 'main-1', anchor: { x: 640, y: 180 }, panel: { width: 300, height: 180 }, main: true, actionable: false, order: 1 },
        { id: 'main-2', anchor: { x: 640, y: 260 }, panel: { width: 300, height: 180 }, main: true, actionable: false, order: 2 },
        { id: 'left', anchor: { x: 220, y: 220 }, panel: { width: 300, height: 180 }, main: false, actionable: true, order: 3 },
        { id: 'right', anchor: { x: 1060, y: 220 }, panel: { width: 300, height: 180 }, main: false, actionable: true, order: 4 },
      ],
      viewport,
    )
    const byId = new Map(placements.map((placement) => [placement.id, placement]))
    expect(byId.get('main-1')?.placement).toBe('right')
    expect(byId.get('main-2')?.placement).toBe('left')
    expect(byId.get('left')?.placement).toBe('left')
    expect(byId.get('right')?.placement).toBe('right')
    for (const placement of placements) {
      expect(placement.left).toBeGreaterThanOrEqual(12)
      expect(placement.top).toBeGreaterThanOrEqual(12)
      expect(placement.left + placement.panel.width).toBeLessThanOrEqual(1268)
      expect(placement.top + placement.panel.height).toBeLessThanOrEqual(788)
    }
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        expect(overlap(placements[i]!, placements[j]!)).toBe(false)
      }
    }
  })

  it('connects a CRT line to the vertical center of its title bar', () => {
    const [placement] = layoutAnchoredCrts(
      [
        {
          id: 'crt',
          anchor: { x: 200, y: 360 },
          panel: { width: 420, height: 240 },
          main: true,
          actionable: false,
          order: 1,
          lineTargetOffsetY: 19,
        },
      ],
      { width: 1200, height: 800, margin: 12 },
    )

    expect(placement).toBeDefined()
    expect(placement!.line.to.y).toBe(placement!.top + 19)
    expect(placement!.line.to.x).toBe(
      placement!.placement === 'right'
        ? placement!.left
        : placement!.left + placement!.panel.width,
    )
  })

  it('never hides approvals/questions when passive concurrency is capped', () => {
    const cards = Array.from({ length: 10 }, (_, order) => ({
      id: `passive:${order}`,
      actionable: false,
      order,
    }))
    cards.push({ id: 'approval', actionable: true, order: 0 })
    cards.push({ id: 'question', actionable: true, order: 0 })
    const result = selectVisibleCrtIds(cards, 3)
    expect(result.visible.has('approval')).toBe(true)
    expect(result.visible.has('question')).toBe(true)
    expect(result.hiddenPassive).toBe(7)
  })

  it('keeps pointer/wheel events, aria tabs and reduced motion inside the CRT contract', async () => {
    const source = await readFile(
      sourcePath('features/pets/nyxus/components/AnchoredRunCrt.vue'),
      'utf8',
    )
    expect(source).toContain('@pointerdown.stop')
    expect(source).toContain('@wheel.stop')
    expect(source).toContain('role="tablist"')
    expect(source).toContain('aria-modal')
    expect(source).toContain('prefers-reduced-motion: reduce')
    expect(source).not.toContain("'tools'")
    expect(source).not.toContain("'action'")
    expect(source).toContain('scrollHeight - el.scrollTop - el.clientHeight > 20')
  })
})
