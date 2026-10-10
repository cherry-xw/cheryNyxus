import { describe, expect, it } from 'vitest'
import type { ConversationBranchSummary, TimelineNode } from '../../../src/services/agentApi'
import { projectCoreFlowExecutionGraph } from '../../../src/features/pets/nyxus/graph/coreFlowProjection'
import type {
  ExecutionEdge,
  ExecutionGraph,
  ExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'

function branch(
  branchId: string,
  chatId: string,
  partial: Partial<ConversationBranchSummary> = {},
): ConversationBranchSummary {
  return {
    branchId,
    taskId: 'task',
    chatId,
    kind: 'original',
    createdAt: 1,
    ...partial,
  }
}

function node(id: string, orderKey: number, branchId: string, sourceChatId: string): ExecutionNode {
  return {
    id,
    kind: 'message',
    rootChatId: 'root-chat',
    sourceChatId,
    actor: { kind: 'agent', chatId: sourceChatId },
    direction: 'agent-to-user',
    content: id,
    createdAt: orderKey,
    status: 'committed',
    main: sourceChatId === 'root-chat',
    orderSlot: 'persistent',
    orderKey,
    activeRuns: [],
    sourceFact: { branchId } as TimelineNode,
  }
}

function start(): ExecutionNode {
  return {
    id: 'start',
    kind: 'start',
    rootChatId: 'root-chat',
    sourceChatId: 'root-chat',
    actor: { kind: 'system' },
    direction: 'internal',
    content: 'start',
    createdAt: Number.NEGATIVE_INFINITY,
    status: 'transient',
    main: true,
    orderSlot: 'start',
    orderKey: null,
    activeRuns: [],
  }
}

function edge(id: string, from: ExecutionNode, to: ExecutionNode): ExecutionEdge {
  return {
    id,
    from: from.id,
    to: to.id,
    kind: 'sequence',
    orderSlot: 'persistent',
    orderKey: to.orderKey,
    sourceChatId: from.sourceChatId,
    targetChatId: to.sourceChatId,
  }
}

function graph(input: {
  activeBranchId?: string
  branches?: ConversationBranchSummary[]
  nodes: ExecutionNode[]
  edges?: ExecutionEdge[]
}): ExecutionGraph {
  return {
    rootChatId: 'root-chat',
    activeBranchId: input.activeBranchId,
    branches: input.branches,
    nodes: input.nodes,
    edges: input.edges ?? [],
    diagnostics: [],
  }
}

function ids(projection: ReturnType<typeof projectCoreFlowExecutionGraph>): string[] {
  return [...projection.coreNodeIds]
}

function detailIds(projection: ReturnType<typeof projectCoreFlowExecutionGraph>): string[] {
  return [...projection.detailNodeIds]
}

describe('core flow execution graph projection', () => {
  it('fails open when branch metadata is unavailable', () => {
    const root = node('root', 1, 'root', 'root-chat')
    const side = node('side', 2, 'side', 'side-chat')
    const projection = projectCoreFlowExecutionGraph(graph({ nodes: [start(), root, side] }))

    expect(ids(projection)).toEqual(['start', 'root', 'side'])
    expect(detailIds(projection)).toEqual([])
    expect(projection.graph.nodes).toHaveLength(3)
  })

  it('keeps the complete active original branch and excludes its child branches', () => {
    const anchor = node('anchor', 1, 'root', 'root-chat')
    const suffix = node('root-suffix', 2, 'root', 'root-chat')
    const child = node('child', 3, 'child', 'child-chat')
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'root',
        branches: [
          branch('root', 'root-chat'),
          branch('child', 'child-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
        ],
        nodes: [start(), anchor, suffix, child],
      }),
    )

    expect(ids(projection)).toEqual(['start', 'anchor', 'root-suffix'])
  })

  it('replaces an ancestor suffix with the active continuation after its anchor', () => {
    const prefix = node('prefix', 1, 'root', 'root-chat')
    const anchor = node('anchor', 2, 'root', 'root-chat')
    const oldSuffix = node('old-suffix', 3, 'root', 'root-chat')
    const continuation = node('continuation', 4, 'child', 'child-chat')
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'child',
        branches: [
          branch('root', 'root-chat'),
          branch('child', 'child-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
        ],
        nodes: [start(), prefix, anchor, oldSuffix, continuation],
      }),
    )

    expect(ids(projection)).toEqual(['start', 'prefix', 'anchor', 'continuation'])
  })

  it('applies replacement cutoffs recursively for nested continuations', () => {
    const rootAnchor = node('root-anchor', 2, 'root', 'root-chat')
    const rootSuffix = node('root-suffix', 3, 'root', 'root-chat')
    const childPrefix = node('child-prefix', 4, 'child', 'child-chat')
    const childAnchor = node('child-anchor', 5, 'child', 'child-chat')
    const childSuffix = node('child-suffix', 6, 'child', 'child-chat')
    const grandchild = node('grandchild', 7, 'grandchild', 'grandchild-chat')
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'grandchild',
        branches: [
          branch('root', 'root-chat'),
          branch('child', 'child-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: rootAnchor.id,
          }),
          branch('grandchild', 'grandchild-chat', {
            kind: 'continuation',
            sourceBranchId: 'child',
            anchorNodeId: childAnchor.id,
          }),
        ],
        nodes: [start(), rootAnchor, rootSuffix, childPrefix, childAnchor, childSuffix, grandchild],
      }),
    )

    expect(ids(projection)).toEqual([
      'start',
      'root-anchor',
      'child-prefix',
      'child-anchor',
      'grandchild',
    ])
  })

  it('restores an ancestor continuation suffix when that branch is reactivated', () => {
    const rootAnchor = node('root-anchor', 2, 'root', 'root-chat')
    const rootSuffix = node('root-suffix', 3, 'root', 'root-chat')
    const childPrefix = node('child-prefix', 4, 'child', 'child-chat')
    const childAnchor = node('child-anchor', 5, 'child', 'child-chat')
    const childSuffix = node('child-suffix', 6, 'child', 'child-chat')
    const grandchild = node('grandchild', 7, 'grandchild', 'grandchild-chat')
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'child',
        branches: [
          branch('root', 'root-chat'),
          branch('child', 'child-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: rootAnchor.id,
          }),
          branch('grandchild', 'grandchild-chat', {
            kind: 'continuation',
            sourceBranchId: 'child',
            anchorNodeId: childAnchor.id,
          }),
        ],
        nodes: [start(), rootAnchor, rootSuffix, childPrefix, childAnchor, childSuffix, grandchild],
      }),
    )

    expect(ids(projection)).toEqual([
      'start',
      'root-anchor',
      'child-prefix',
      'child-anchor',
      'child-suffix',
    ])
  })

  it('excludes sibling continuation and detail branches from an active chain', () => {
    const rootAnchor = node('root-anchor', 1, 'root', 'root-chat')
    const active = node('active', 2, 'active', 'active-chat')
    const sibling = node('sibling', 3, 'sibling', 'sibling-chat')
    const detail = node('detail', 4, 'detail', 'detail-chat')
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'active',
        branches: [
          branch('root', 'root-chat'),
          branch('active', 'active-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: rootAnchor.id,
          }),
          branch('sibling', 'sibling-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: rootAnchor.id,
          }),
          branch('detail', 'detail-chat', {
            kind: 'detail',
            sourceBranchId: 'root',
            anchorNodeId: rootAnchor.id,
          }),
        ],
        nodes: [start(), rootAnchor, active, sibling, detail],
      }),
    )

    expect(ids(projection)).toEqual(['start', 'root-anchor', 'active'])
    expect(detailIds(projection)).toEqual(['detail'])
    expect(projection.paperGraph.nodes.map((item) => item.id)).toEqual([
      'start',
      'root-anchor',
      'active',
      'detail',
    ])
    expect(projection.paperGraph.nodes.some((item) => item.id === 'sibling')).toBe(false)
  })

  it('inherits a fold classification from its projected canonical nodes', () => {
    const anchor = node('anchor', 1, 'root', 'root-chat')
    const coreMember = node('core-member', 2, 'active', 'active-chat')
    const sideMember = node('side-member', 3, 'side', 'side-chat')
    const folded = (id: string, projected: ExecutionNode): ExecutionNode => ({
      ...projected,
      id,
      kind: 'fold',
      sourceFact: undefined,
      fold: {
        firstNodeId: projected.id,
        lastNodeId: projected.id,
        members: [{ id: projected.id, displayNode: projected, nodes: [projected] }],
        projectionNodes: [projected],
      },
    })
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'active',
        branches: [
          branch('root', 'root-chat'),
          branch('active', 'active-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
          branch('side', 'side-chat', {
            kind: 'detail',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
        ],
        nodes: [start(), anchor, folded('core-fold', coreMember), folded('side-fold', sideMember)],
      }),
    )

    expect(ids(projection)).toEqual(['start', 'anchor', 'core-fold'])
    expect(detailIds(projection)).toEqual(['side-fold'])
  })

  it('maps transient nodes by branch chat and fails open when ownership is unknown', () => {
    const anchor = node('anchor', 1, 'root', 'root-chat')
    const transient = (id: string, sourceChatId: string): ExecutionNode => ({
      ...node(id, 2, 'unused', sourceChatId),
      orderSlot: 'transient',
      orderKey: null,
      status: 'transient',
      sourceFact: undefined,
    })
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'active',
        branches: [
          branch('root', 'root-chat'),
          branch('active', 'active-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
          branch('side', 'side-chat', {
            kind: 'detail',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
        ],
        nodes: [
          start(),
          anchor,
          transient('ancestor-live', 'root-chat'),
          transient('active-live', 'active-chat'),
          transient('side-live', 'side-chat'),
          transient('unknown-live', 'unknown-chat'),
        ],
      }),
    )

    expect(ids(projection)).toEqual([
      'start',
      'anchor',
      'ancestor-live',
      'active-live',
      'unknown-live',
    ])
    expect(detailIds(projection)).toEqual(['side-live'])
  })

  it.each(['missing source', 'missing anchor', 'cycle'])('fails open for %s metadata', (kind) => {
    const anchor = node('anchor', 1, 'root', 'root-chat')
    const side = node('side', 2, 'child', 'child-chat')
    const root = branch('root', 'root-chat')
    const child = branch('child', 'child-chat', {
      kind: 'continuation',
      sourceBranchId: kind === 'missing source' ? 'missing' : 'root',
      anchorNodeId: kind === 'missing anchor' ? 'missing' : anchor.id,
    })
    if (kind === 'cycle') {
      root.kind = 'continuation'
      root.sourceBranchId = 'child'
      root.anchorNodeId = side.id
    }
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'child',
        branches: [root, child],
        nodes: [start(), anchor, side],
      }),
    )

    expect(ids(projection)).toEqual(['start', 'anchor', 'side'])
    expect(detailIds(projection)).toEqual([])
  })

  it('filters core-graph edges unless both endpoints are core', () => {
    const anchor = node('anchor', 1, 'root', 'root-chat')
    const oldSuffix = node('old-suffix', 2, 'root', 'root-chat')
    const active = node('active', 3, 'active', 'active-chat')
    const rootStart = start()
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'active',
        branches: [
          branch('root', 'root-chat'),
          branch('active', 'active-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
        ],
        nodes: [rootStart, anchor, oldSuffix, active],
        edges: [
          edge('start-anchor', rootStart, anchor),
          edge('anchor-old', anchor, oldSuffix),
          edge('anchor-active', anchor, active),
          edge('old-active', oldSuffix, active),
        ],
      }),
    )

    expect(projection.graph.edges.map((item) => item.id)).toEqual(['start-anchor', 'anchor-active'])
  })

  it('keeps detail entry and internal edges in the paper graph', () => {
    const anchor = node('anchor', 1, 'root', 'root-chat')
    const active = node('active', 2, 'active', 'active-chat')
    const detailInput = node('detail-input', 3, 'detail', 'detail-chat')
    const detailAnswer = node('detail-answer', 4, 'detail', 'detail-chat')
    const oldSuffix = node('old-suffix', 5, 'root', 'root-chat')
    const rootStart = start()
    const projection = projectCoreFlowExecutionGraph(
      graph({
        activeBranchId: 'active',
        branches: [
          branch('root', 'root-chat'),
          branch('active', 'active-chat', {
            kind: 'continuation',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
          branch('detail', 'detail-chat', {
            kind: 'detail',
            sourceBranchId: 'root',
            anchorNodeId: anchor.id,
          }),
        ],
        nodes: [rootStart, anchor, active, detailInput, detailAnswer, oldSuffix],
        edges: [
          edge('start-anchor', rootStart, anchor),
          edge('anchor-active', anchor, active),
          edge('anchor-detail', anchor, detailInput),
          edge('detail-answer', detailInput, detailAnswer),
          edge('anchor-old', anchor, oldSuffix),
        ],
      }),
    )

    expect(projection.paperGraph.nodes.map((item) => item.id)).toEqual([
      'start',
      'anchor',
      'active',
      'detail-input',
      'detail-answer',
    ])
    expect(projection.paperGraph.edges.map((item) => item.id)).toEqual([
      'start-anchor',
      'anchor-active',
      'anchor-detail',
      'detail-answer',
    ])
  })
})
