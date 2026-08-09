import { describe, expect, it } from 'vitest'
import type { ExecutionNode, ExecutionNodeKind } from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  canPinNodeDetail,
  hasNodeHoverDetail,
} from '../../../src/features/pets/nyxus/graph/nodeSkins'

const NODE_KINDS: ExecutionNodeKind[] = [
  'start',
  'message',
  'tool-batch',
  'return',
  'dispatch',
  'system',
  'spawn',
  'fold',
  'input',
  'unknown',
]

function node(kind: ExecutionNodeKind): ExecutionNode {
  return {
    id: `${kind}:test`,
    kind,
    rootChatId: 'root',
    sourceChatId: 'root',
    actor: { kind: 'system' },
    direction: 'internal',
    content: kind,
    createdAt: 0,
    status: 'transient',
    main: true,
    orderSlot: kind === 'start' ? 'start' : 'transient',
    orderKey: null,
    activeRuns: [],
  }
}

describe('execution node hover details', () => {
  it('covers every rendered node kind', () => {
    expect(NODE_KINDS.every((kind) => hasNodeHoverDetail(node(kind)))).toBe(true)
  })

  it('does not broaden the existing click-to-pin interaction', () => {
    expect(canPinNodeDetail(node('message'))).toBe(false)
    expect(canPinNodeDetail(node('start'))).toBe(false)
    expect(canPinNodeDetail(node('tool-batch'))).toBe(true)
    expect(canPinNodeDetail(node('fold'))).toBe(true)
  })
})
