import { describe, expect, it } from 'vitest'
import type {
  ExecutionEdgeFact,
  RootTimelineSnapshot,
  TimelineNode,
} from '../../../web/src/services/agentApi'
import { projectPersistentExecutionGraph } from '../../../web/src/features/pets/nyxus/graph/executionGraph'
import { buildReferenceCanonicalTimelineTree } from '../graph/referenceExecutionTree'

const rootChatId = 'root-chat'

function node(
  id: string,
  orderKey: number,
  patch: Partial<TimelineNode> = {},
): TimelineNode {
  return {
    id,
    rootChatId,
    sourceChatId: rootChatId,
    sourceMessageId: id,
    kind: 'message',
    actor: { kind: 'agent', chatId: rootChatId },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    ...patch,
  }
}

function edge(
  id: string,
  orderKey: number,
  fromNodeId: string,
  toNodeId: string,
  kind: ExecutionEdgeFact['kind'],
  patch: Partial<ExecutionEdgeFact> = {},
): ExecutionEdgeFact {
  return {
    id,
    rootChatId,
    fromNodeId,
    toNodeId,
    kind,
    orderKey,
    sourceChatId: rootChatId,
    targetChatId: rootChatId,
    ...patch,
  }
}

function snapshot(): RootTimelineSnapshot {
  const nodes: TimelineNode[] = [
    node('root-input', 1, {
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: rootChatId },
      direction: 'user-to-agent',
    }),
    node('root-tool-message', 2, {
      sourceMessageId: 'root-tool-response',
      content: 'delegating work',
    }),
    node('root-tool-batch', 3, {
      sourceMessageId: 'root-tool-response',
      kind: 'tool-batch',
      direction: 'internal',
      visibility: 'detail',
      content: '',
      batchId: 'root-tool-batch',
      toolCalls: [{
        callId: 'spawn-call',
        index: 0,
        name: 'spawn_role',
        arguments: '{"type":"reader"}',
        childChatId: 'child-chat',
        status: 'completed',
      }],
    }),
    node('spawn-target:task-reader', 4, {
      sourceChatId: 'child-chat',
      kind: 'dispatch',
      actor: { kind: 'agent', chatId: rootChatId },
      target: { kind: 'agent', chatId: 'child-chat' },
      direction: 'parent-to-child',
      visibility: 'internal',
      taskId: 'task-reader',
    }),
    node('child-input', 5, {
      sourceChatId: 'child-chat',
      actor: { kind: 'agent', chatId: rootChatId },
      target: { kind: 'agent', chatId: 'child-chat' },
      direction: 'parent-to-child',
    }),
    node('child-output', 6, {
      sourceChatId: 'child-chat',
      actor: { kind: 'agent', chatId: 'child-chat' },
      target: { kind: 'agent', chatId: rootChatId },
    }),
    node('child-return', 7, {
      sourceChatId: 'child-chat',
      kind: 'return',
      actor: { kind: 'agent', chatId: 'child-chat' },
      target: { kind: 'agent', chatId: rootChatId },
      direction: 'child-to-parent',
    }),
    node('root-after-return', 8),
  ]
  const edges: ExecutionEdgeFact[] = [
    edge('edge-root-input-tool', 9, 'root-input', 'root-tool-message', 'sequence'),
    edge('edge-tool-batch', 10, 'root-tool-message', 'root-tool-batch', 'sequence'),
    edge('edge-spawn', 11, 'root-tool-batch', 'spawn-target:task-reader', 'spawn', {
      targetChatId: 'child-chat',
      callId: 'spawn-call',
    }),
    edge('edge-child-input', 12, 'spawn-target:task-reader', 'child-input', 'sequence', {
      sourceChatId: 'child-chat',
      targetChatId: 'child-chat',
    }),
    edge('edge-child-output', 13, 'child-input', 'child-output', 'sequence', {
      sourceChatId: 'child-chat',
      targetChatId: 'child-chat',
    }),
    edge('edge-return', 14, 'child-output', 'child-return', 'return', {
      sourceChatId: 'child-chat',
    }),
    edge('edge-return-continuation', 15, 'child-return', 'root-after-return', 'return-continuation', {
      sourceChatId: 'child-chat',
    }),
    edge('edge-root-continue', 16, 'root-tool-batch', 'root-after-return', 'continue'),
  ]
  return {
    rootChatId,
    view: 'tree',
    revision: 1,
    nodes,
    edges,
    activeRuns: [],
    pendingInputs: [],
    generations: [],
    capturedEventSeq: 0,
  }
}

describe('canonical protocol tree -> workbench execution graph', () => {
  it('represents every canonical node directly or through an explicit UI collapse', () => {
    const canonical = snapshot()
    const reference = buildReferenceCanonicalTimelineTree(canonical)
    const projected = projectPersistentExecutionGraph(canonical)

    expect(reference.nodes).toHaveLength(canonical.nodes.length)
    expect(reference.edges).toHaveLength(canonical.edges.length)
    expect(projected.diagnostics).toEqual([])

    const represented = new Set(
      projected.nodes.flatMap((item) => item.sourceFact ? [item.sourceFact.id] : []),
    )
    const pairedResponses = new Map(
      canonical.nodes
        .filter((item) => item.kind === 'tool-batch' && item.sourceMessageId)
        .map((item) => [`${item.sourceChatId}:${item.sourceMessageId}`, item.id]),
    )
    const collapsedSpawnTargets = new Map(
      canonical.edges
        .filter((item) => item.kind === 'sequence' && item.fromNodeId.startsWith('spawn-target:'))
        .map((item) => [item.fromNodeId, item.toNodeId]),
    )
    const missing = reference.nodes.filter((item) => {
      if (represented.has(item.id)) return false
      if (
        item.kind === 'message' &&
        'sourceMessageId' in item &&
        pairedResponses.has(`${item.sourceChatId}:${String(item.sourceMessageId)}`)
      ) return false
      const collapsedInto = collapsedSpawnTargets.get(item.id)
      return !collapsedInto || !represented.has(collapsedInto)
    })
    expect(missing).toEqual([])

    const projectedIds = new Set(projected.nodes.map((item) => item.id))
    expect(projected.edges.every((item) => projectedIds.has(item.from) && projectedIds.has(item.to))).toBe(true)
    expect(projected.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'edge-spawn', from: 'root-tool-batch', to: 'child-input' }),
      expect.objectContaining({ id: 'edge-return', from: 'child-output', to: 'child-return' }),
      expect.objectContaining({
        id: 'edge-return-continuation',
        from: 'child-return',
        to: 'root-after-return',
      }),
    ]))
  })
})
