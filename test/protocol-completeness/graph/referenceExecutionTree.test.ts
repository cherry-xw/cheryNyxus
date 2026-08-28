import { describe, expect, it } from 'vitest'
import {
  buildReferenceExecutionTree,
  type ProtocolTreeSnapshot,
} from './referenceExecutionTree.js'

function completeSnapshot(): ProtocolTreeSnapshot {
  const rootChatId = 'root-chat'
  return {
    rootChatId,
    activeEpochByChat: {
      'root-chat': 'epoch-root-2',
      'child-old': 'epoch-child-2',
      'child-new': 'epoch-child-new-1',
    },
    nodes: [
      {
        id: 'root-input',
        kind: 'user-input',
        rootChatId,
        chatId: 'root-chat',
        epochId: 'epoch-root-2',
        runId: 'run-root',
        order: 1,
      },
      {
        id: 'root-model-tools',
        kind: 'model-turn',
        rootChatId,
        chatId: 'root-chat',
        epochId: 'epoch-root-2',
        runId: 'run-root',
        order: 2,
      },
      {
        id: 'root-tool-batch',
        kind: 'tool-batch',
        rootChatId,
        chatId: 'root-chat',
        epochId: 'epoch-root-2',
        runId: 'run-root',
        callIds: ['call-spawn-old'],
        order: 3,
      },
      {
        id: 'spawn-old-child',
        kind: 'spawn',
        rootChatId,
        chatId: 'root-chat',
        epochId: 'epoch-root-2',
        runId: 'run-root',
        taskId: 'task-old',
        targetChatId: 'child-old',
        order: 4,
      },
      {
        id: 'old-child-input',
        kind: 'user-input',
        rootChatId,
        chatId: 'child-old',
        epochId: 'epoch-child-1',
        runId: 'run-old',
        lifecycle: 'abandoned',
        order: 5,
      },
      {
        id: 'old-child-error',
        kind: 'error',
        rootChatId,
        chatId: 'child-old',
        epochId: 'epoch-child-1',
        runId: 'run-old',
        lifecycle: 'abandoned',
        order: 6,
      },
      {
        id: 'root-after-abandon',
        kind: 'model-turn',
        rootChatId,
        chatId: 'root-chat',
        epochId: 'epoch-root-2',
        runId: 'run-root-2',
        order: 7,
      },
      {
        id: 'dispatch-new-child',
        kind: 'dispatch',
        rootChatId,
        chatId: 'root-chat',
        epochId: 'epoch-root-2',
        runId: 'run-root-2',
        taskId: 'task-new',
        targetChatId: 'child-new',
        order: 8,
      },
      {
        id: 'new-child-input',
        kind: 'user-input',
        rootChatId,
        chatId: 'child-new',
        epochId: 'epoch-child-new-1',
        runId: 'run-new',
        order: 9,
      },
      {
        id: 'new-child-model',
        kind: 'model-turn',
        rootChatId,
        chatId: 'child-new',
        epochId: 'epoch-child-new-1',
        runId: 'run-new',
        order: 10,
      },
      {
        id: 'new-child-return',
        kind: 'return',
        rootChatId,
        chatId: 'child-new',
        epochId: 'epoch-child-new-1',
        runId: 'run-new',
        taskId: 'task-new',
        targetChatId: 'root-chat',
        order: 11,
      },
      {
        id: 'root-terminal',
        kind: 'terminal',
        rootChatId,
        chatId: 'root-chat',
        epochId: 'epoch-root-2',
        runId: 'run-root-2',
        order: 12,
      },
    ],
    edges: [
      { from: 'root-input', to: 'root-model-tools', kind: 'sequence' },
      { from: 'root-model-tools', to: 'root-tool-batch', kind: 'tool' },
      { from: 'root-tool-batch', to: 'spawn-old-child', kind: 'spawn' },
      { from: 'spawn-old-child', to: 'old-child-input', kind: 'spawn' },
      { from: 'old-child-input', to: 'old-child-error', kind: 'sequence' },
      { from: 'root-tool-batch', to: 'root-after-abandon', kind: 'continue' },
      { from: 'root-after-abandon', to: 'dispatch-new-child', kind: 'dispatch' },
      { from: 'dispatch-new-child', to: 'new-child-input', kind: 'dispatch' },
      { from: 'new-child-input', to: 'new-child-model', kind: 'sequence' },
      { from: 'new-child-model', to: 'new-child-return', kind: 'return' },
      { from: 'new-child-return', to: 'root-terminal', kind: 'return-continuation' },
    ],
  }
}

describe('independent reference execution tree', () => {
  it('builds every protocol node once with no dangling edge or cycle', () => {
    const snapshot = completeSnapshot()
    const tree = buildReferenceExecutionTree(snapshot)

    expect(tree.nodes).toHaveLength(snapshot.nodes.length)
    expect(tree.edges).toHaveLength(snapshot.edges.length)
    expect(new Set(tree.nodes.map((node) => node.id)).size).toBe(tree.nodes.length)
    expect(tree.roots).toEqual(['root-input'])
    expect(tree.nodes.map((node) => node.kind)).toEqual([
      'user-input',
      'model-turn',
      'tool-batch',
      'spawn',
      'user-input',
      'error',
      'model-turn',
      'dispatch',
      'user-input',
      'model-turn',
      'return',
      'terminal',
    ])
  })

  it('keeps old epochs and abandoned subtrees visible but non-executable', () => {
    const tree = buildReferenceExecutionTree(completeSnapshot())
    const oldBranch = tree.nodes.filter((node) => node.chatId === 'child-old')
    const newBranch = tree.nodes.filter((node) => node.chatId === 'child-new')

    expect(oldBranch.every((node) => node.executable === false)).toBe(true)
    expect(newBranch.filter((node) => node.kind !== 'return').every((node) => node.executable)).toBe(
      true,
    )
    expect(tree.nodes.find((node) => node.id === 'root-terminal')?.executable).toBe(false)
  })

  it('rejects duplicate nodes, dangling edges, cycles and incomplete tool ownership', () => {
    const duplicate = completeSnapshot()
    duplicate.nodes = [...duplicate.nodes, duplicate.nodes[0]!]
    expect(() => buildReferenceExecutionTree(duplicate)).toThrow('duplicate node id')

    const dangling = completeSnapshot()
    dangling.edges = [...dangling.edges, { from: 'missing', to: 'root-input', kind: 'sequence' }]
    expect(() => buildReferenceExecutionTree(dangling)).toThrow('dangling edge source')

    const cycle = completeSnapshot()
    cycle.edges = [...cycle.edges, { from: 'root-terminal', to: 'root-input', kind: 'sequence' }]
    expect(() => buildReferenceExecutionTree(cycle)).toThrow('cycle detected')

    const malformed = completeSnapshot()
    malformed.nodes = malformed.nodes.map((node) =>
      node.id === 'root-tool-batch' ? { ...node, callIds: [] } : node,
    )
    expect(() => buildReferenceExecutionTree(malformed)).toThrow('has no call ids')
  })
})
