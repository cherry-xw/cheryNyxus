import { describe, expect, it } from 'vitest'
import type { ActiveRunFact, ExecutionEdgeFact, TimelineNode } from '../../../src/services/agentApi'
import {
  projectActiveTurnNodes,
  projectExecutionGraph,
  type ExecutionGraphSnapshot,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import type { ActiveTurnSnapshot } from '../../../src/features/pets/nyxus/graph/executionGraph'

function node(id: string, orderKey: number, partial: Partial<TimelineNode> = {}): TimelineNode {
  return {
    id,
    rootChatId: 'root',
    sourceChatId: 'root',
    kind: 'message',
    actor: { kind: 'agent', chatId: 'root' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    ...partial,
  }
}

function edge(
  id: string,
  orderKey: number,
  fromNodeId: string,
  toNodeId: string,
  kind: ExecutionEdgeFact['kind'] = 'sequence',
  partial: Partial<ExecutionEdgeFact> = {},
): ExecutionEdgeFact {
  return {
    id,
    rootChatId: 'root',
    fromNodeId,
    toNodeId,
    kind,
    orderKey,
    sourceChatId: 'root',
    targetChatId: 'root',
    ...partial,
  }
}

function snapshot(
  nodes: TimelineNode[],
  edges: ExecutionEdgeFact[] = [],
  activeRuns: ActiveRunFact[] = [],
): ExecutionGraphSnapshot {
  return { rootChatId: 'root', nodes, edges, activeRuns }
}

function turn(
  chatId: string,
  turnId: string,
  messageId: string,
  createdAt: number,
  partial: Partial<ActiveTurnSnapshot> = {},
): ActiveTurnSnapshot {
  return {
    chatId,
    turnId,
    runId: `run:${turnId}`,
    messageId,
    thinking: '',
    content: `delta ${turnId}`,
    status: 'running',
    createdAt,
    ...partial,
  }
}

describe('projectActiveTurnNodes transient 锚定', () => {
  it('同 chat 两个 live turn 在单次投影内串联成链', () => {
    const base = projectExecutionGraph(snapshot([node('root-node', 1)]))
    const live = projectActiveTurnNodes(base, [
      turn('child', 't1', 'msg-1', 3),
      turn('child', 't2', 'msg-2', 4),
    ], [])

    const streamEdges = live.edges.filter((e) => e.kind === 'stream')
    expect(streamEdges).toHaveLength(2)
    expect(streamEdges[0]).toMatchObject({ from: 'start:root', to: 'msg-1' })
    expect(streamEdges[1]).toMatchObject({ from: 'msg-1', to: 'msg-2' })
  })

  it('子 chat 无任何持久节点时首节点连 start（无头兜底）', () => {
    const base = projectExecutionGraph(snapshot([node('root-node', 1)]))
    const live = projectActiveTurnNodes(base, [
      turn('child-a', 't1', 'msg-a', 3),
      turn('child-b', 't2', 'msg-b', 4),
    ], [])

    const streamEdges = live.edges.filter((e) => e.kind === 'stream')
    expect(streamEdges.map((e) => e.from)).toEqual(['start:root', 'start:root'])
  })

  it('dispatch 锚点优先于子 chat 自己的消息节点（不依赖数组遍历顺序）', () => {
    const dispatchTarget = node('dispatch:child', 2, {
      sourceChatId: 'root',
      kind: 'dispatch',
      actor: { kind: 'agent', chatId: 'root' },
      target: { kind: 'agent', chatId: 'child' },
      direction: 'parent-to-child',
    })
    // 子 chat 自己的旧回复节点（createdAt 更大）故意排在 dispatch 之后，
    // 验证派发锚点不被普通消息节点覆盖。
    const childReply = node('child-reply', 4, { sourceChatId: 'child' })
    const base = projectExecutionGraph(
      snapshot(
        [node('root-node', 1), dispatchTarget, childReply],
        [edge('dispatch-edge', 3, 'root-node', 'dispatch:child', 'dispatch')],
      ),
    )
    const live = projectActiveTurnNodes(base, [turn('child', 't1', 'child:message', 5)], [])

    const streamEdge = live.edges.filter((e) => e.kind === 'stream')[0]
    expect(streamEdge).toMatchObject({ from: 'dispatch:child', to: 'child:message' })
  })

  it('普通消息节点按 createdAt 取该 chat 最新（消除遍历顺序依赖）', () => {
    const base = projectExecutionGraph(
      snapshot([
        node('root-node', 1),
        node('child-old', 2, { sourceChatId: 'child' }),
        node('child-new', 4, { sourceChatId: 'child' }),
      ]),
    )
    const live = projectActiveTurnNodes(base, [turn('child', 't1', 'child:message', 5)], [])

    const streamEdge = live.edges.filter((e) => e.kind === 'stream')[0]
    expect(streamEdge).toMatchObject({ from: 'child-new', to: 'child:message' })
  })
})
