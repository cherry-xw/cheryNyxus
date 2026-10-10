import { describe, expect, it } from 'vitest'
import type {
  ConversationBranchSummary,
  ExecutionEdgeFact,
  RootTimelineSnapshot,
  TimelineNode,
} from '../../src/services/agentApi'
import { detailBranchContextNodes } from '../../src/features/agent/drawer/detailBranchContext'

function node(id: string, orderKey: number, partial: Partial<TimelineNode> = {}): TimelineNode {
  return {
    id,
    rootChatId: 'root',
    sourceChatId: 'root',
    kind: 'message',
    actor: { kind: 'user' },
    direction: 'user-to-agent',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    ...partial,
  }
}

function edge(fromNodeId: string, toNodeId: string, orderKey: number): ExecutionEdgeFact {
  return {
    id: `${fromNodeId}:${toNodeId}`,
    rootChatId: 'root',
    fromNodeId,
    toNodeId,
    kind: 'sequence',
    orderKey,
    sourceChatId: 'root',
    targetChatId: 'root',
  }
}

function snapshot(nodes: TimelineNode[], edges: ExecutionEdgeFact[]): RootTimelineSnapshot {
  return {
    rootChatId: 'root',
    taskId: 'task',
    view: 'conversation',
    revision: 1,
    nodes,
    edges,
    activeRuns: [],
    pendingInputs: [],
    capturedEventSeq: 1,
  }
}

function detailBranch(partial: Partial<ConversationBranchSummary> = {}): ConversationBranchSummary {
  return {
    branchId: 'detail-branch',
    taskId: 'task',
    chatId: 'detail-chat',
    kind: 'detail',
    anchorNodeId: 'anchor',
    createdAt: 10,
    ...partial,
  }
}

describe('detail branch context projection', () => {
  it('returns the full causal conversation path through the fork anchor', () => {
    const unrelated = node('unrelated', 4)
    const internal = node('internal', 2, { visibility: 'internal' })
    const data = snapshot(
      [node('question', 1), internal, node('anchor', 3), unrelated, node('detail-input', 5)],
      [
        edge('question', 'internal', 1),
        edge('internal', 'anchor', 2),
        edge('anchor', 'detail-input', 3),
      ],
    )

    expect(detailBranchContextNodes(data, detailBranch()).map((item) => item.id)).toEqual([
      'question',
      'anchor',
    ])
  })

  it('follows an earlier branch fork when the explanation is nested', () => {
    const data = snapshot(
      [node('original', 1), node('first-fork-input', 10), node('anchor', 11)],
      [edge('original', 'first-fork-input', 1), edge('first-fork-input', 'anchor', 2)],
    )

    expect(detailBranchContextNodes(data, detailBranch()).map((item) => item.id)).toEqual([
      'original',
      'first-fork-input',
      'anchor',
    ])
  })

  it('safely omits context for non-detail branches and missing anchors', () => {
    const data = snapshot([node('anchor', 1)], [])
    expect(detailBranchContextNodes(data, detailBranch({ kind: 'continuation' }))).toEqual([])
    expect(detailBranchContextNodes(data, detailBranch({ anchorNodeId: 'missing' }))).toEqual([])
  })
})
