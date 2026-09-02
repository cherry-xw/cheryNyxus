import { describe, expect, it } from 'vitest'
import type {
  ExecutionGraph,
  ExecutionNode,
  PositionedExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import { layoutExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionLayout'
import {
  projectExecutionPresentation,
  projectExecutionNodePriorities,
  signalVisualKindFor,
  toolVisualKindFor,
  SIGNAL_COLUMN_STRIDE,
  SIGNAL_MIN_WIRE_GAP,
  SIGNAL_NODE_SIZE,
} from '../../../src/features/pets/nyxus/graph/executionPresentation'
import { horizontalExecutionEdgeGeometry } from '../../../src/features/pets/nyxus/graph/executionGeometry'

function node(id: string, order: number, chatId = 'root'): ExecutionNode {
  return {
    id,
    kind: order === 0 ? 'start' : 'message',
    rootChatId: 'root',
    sourceChatId: chatId,
    actor: order === 0 ? { kind: 'system' } : { kind: 'agent', chatId },
    direction: order === 0 ? 'internal' : 'agent-to-user',
    content: id,
    createdAt: order,
    status: 'committed',
    main: chatId === 'root',
    orderSlot: order === 0 ? 'start' : 'persistent',
    orderKey: order || null,
    activeRuns: [],
  }
}

function graph(): ExecutionGraph {
  const nodes = [node('start', 0), node('spawn', 1), node('child', 2, 'child'), node('tail', 3)]
  return {
    rootChatId: 'root',
    nodes,
    edges: [
      {
        id: 'root-chain',
        from: 'start',
        to: 'spawn',
        kind: 'sequence',
        orderSlot: 'persistent',
        orderKey: 1,
        sourceChatId: 'root',
        targetChatId: 'root',
      },
      {
        id: 'spawn-child',
        from: 'spawn',
        to: 'child',
        kind: 'spawn',
        orderSlot: 'persistent',
        orderKey: 2,
        sourceChatId: 'root',
        targetChatId: 'child',
      },
      {
        id: 'child-return',
        from: 'child',
        to: 'tail',
        kind: 'return',
        orderSlot: 'persistent',
        orderKey: 3,
        sourceChatId: 'child',
        targetChatId: 'root',
      },
    ],
    diagnostics: [],
  }
}

function toolNode(name: string): PositionedExecutionNode {
  return {
    ...node('tool', 1),
    kind: 'tool-batch',
    sourceFact: {
      toolCalls: [{ index: 0, callId: 'c1', name, status: 'completed' }],
    } as ExecutionNode['sourceFact'],
  } as PositionedExecutionNode
}

describe('horizontal Signal Grid presentation', () => {
  it('rotates progress to x while preserving canonical node and edge facts', () => {
    const classic = projectExecutionPresentation(layoutExecutionGraph(graph()), 'vertical-classic')
    const signal = projectExecutionPresentation(classic, 'horizontal-signal')

    expect(signal.presentation).toBe('horizontal-signal')
    expect(signal.nodes.map((entry) => entry.id)).toEqual(classic.nodes.map((entry) => entry.id))
    expect(
      signal.edges.map(({ id, from, to, kind }) => ({ id, from: from.id, to: to.id, kind })),
    ).toEqual(
      classic.edges.map(({ id, from, to, kind }) => ({ id, from: from.id, to: to.id, kind })),
    )
    expect(signal.nodes.every((entry, index, all) => index === 0 || entry.x >= all[index - 1]!.x)).toBe(true)
    // R2 直连回退：Signal 投影不再分配 routeY；canonical 绕行边的 routeX→routeY 映射保留。
    expect(signal.edges.some((edge) => edge.routeY !== undefined)).toBe(true)
    expect(signal.edges.every((edge) => edge.routeX === undefined)).toBe(true)
  })

  it('terminates horizontal fibers at the rectangular node ports', () => {
    const halfWidth = SIGNAL_NODE_SIZE.width / 2
    const geometry = horizontalExecutionEdgeGeometry(
      { x: 100, y: 40 },
      { x: 300, y: 150 },
      halfWidth,
      90,
    )

    expect(geometry.from.x).toBe(100 + halfWidth)
    expect(geometry.to.x).toBe(300 - halfWidth)
    expect(geometry.control1.y).toBe(90)
    expect(geometry.control2.y).toBe(90)
  })

  it('promotes user prompts, final replies and errors without changing canonical facts', () => {
    const nodes = [
      node('start', 0),
      { ...node('user', 1), actor: { kind: 'user' as const, actorId: 'human' }, direction: 'user-to-agent' as const },
      node('draft', 2),
      node('final', 3),
      {
        ...node('error', 4),
        sourceFact: { termination: { code: 'error' } } as ExecutionNode['sourceFact'],
      },
    ]
    const projected = projectExecutionNodePriorities(
      nodes.map((entry, index) => ({ ...entry, x: 0, y: index * 82, lane: 0 })),
    )
    expect(projected.find((entry) => entry.id === 'user')?.presentationPriority).toBe('hero-user')
    expect(projected.find((entry) => entry.id === 'final')?.presentationPriority).toBe('hero-final')
    expect(projected.find((entry) => entry.id === 'error')?.presentationPriority).toBe('hero-error')
    expect(projected.find((entry) => entry.id === 'draft')?.presentationPriority).toBe('process')
  })

  it('maps every node to its badge visual kind (zero-text principle)', () => {
    expect(signalVisualKindFor({ kind: 'start', actor: { kind: 'system' }, direction: 'internal' }, 'process')).toBe('start')
    expect(signalVisualKindFor({ kind: 'fold', actor: { kind: 'agent' }, direction: 'internal' }, 'fold')).toBe('fold')
    expect(signalVisualKindFor({ kind: 'pack', actor: { kind: 'agent' }, direction: 'internal' }, 'fold')).toBe('fold')
    expect(signalVisualKindFor({ kind: 'spawn', actor: { kind: 'agent' }, direction: 'internal' }, 'process')).toBe('dispatch')
    expect(signalVisualKindFor({ kind: 'dispatch', actor: { kind: 'agent' }, direction: 'internal' }, 'process')).toBe('dispatch')
    expect(signalVisualKindFor({ kind: 'return', actor: { kind: 'agent' }, direction: 'agent-to-user' }, 'process')).toBe('return')
    expect(signalVisualKindFor({ kind: 'system', actor: { kind: 'system' }, direction: 'internal' }, 'process')).toBe('system')
    expect(signalVisualKindFor({ kind: 'input', actor: { kind: 'user' }, direction: 'user-to-agent' }, 'hero-user')).toBe('input')
    expect(signalVisualKindFor({ kind: 'message', actor: { kind: 'user' }, direction: 'user-to-agent' }, 'hero-user')).toBe('input')
    expect(signalVisualKindFor({ kind: 'message', actor: { kind: 'agent' }, direction: 'agent-to-user' }, 'hero-final')).toBe('reply')
    expect(signalVisualKindFor({ kind: 'message', actor: { kind: 'agent' }, direction: 'agent-to-user' }, 'hero-error')).toBe('error')
    expect(signalVisualKindFor({ kind: 'message', actor: { kind: 'agent' }, direction: 'agent-to-user' }, 'process')).toBe('process')
    expect(signalVisualKindFor({ kind: 'tool-batch', actor: { kind: 'agent' }, direction: 'internal' }, 'process')).toBe('tool-generic')
  })

  it('classifies tool batches into built-in tool visual kinds', () => {
    expect(toolVisualKindFor(toolNode('run_command'))).toBe('tool-command')
    expect(toolVisualKindFor(toolNode('read_file'))).toBe('tool-read')
    expect(toolVisualKindFor(toolNode('write_file'))).toBe('tool-write')
    expect(toolVisualKindFor(toolNode('search_codebase'))).toBe('tool-search')
    expect(toolVisualKindFor(toolNode('activate_skill'))).toBe('tool-skill')
    expect(toolVisualKindFor(toolNode('ask_user_question'))).toBe('tool-question')
    expect(toolVisualKindFor(toolNode('spawn_agent'))).toBe('tool-spawn')
    expect(toolVisualKindFor(toolNode('custom_unknown'))).toBe('tool-generic')
  })

  it('renders every node inside one uniform fixed-size badge', () => {
    const signal = projectExecutionPresentation(layoutExecutionGraph(graph()), 'horizontal-signal')
    expect(signal.nodes.length).toBeGreaterThan(0)
    for (const entry of signal.nodes) {
      expect(entry.visualBounds!.right - entry.visualBounds!.left).toBe(SIGNAL_NODE_SIZE.width)
      expect(entry.visualBounds!.bottom - entry.visualBounds!.top).toBe(SIGNAL_NODE_SIZE.height)
    }
  })

  it('lays out columns at a fixed stride with the minimum wire gap', () => {
    const signal = projectExecutionPresentation(layoutExecutionGraph(graph()), 'horizontal-signal')
    const columns = [...new Set(signal.nodes.map((entry) => entry.x))].sort((a, b) => a - b)
    expect(columns.length).toBeGreaterThan(1)
    for (let index = 1; index < columns.length; index += 1) {
      expect(columns[index]! - columns[index - 1]!).toBe(SIGNAL_COLUMN_STRIDE)
    }
    for (let index = 1; index < signal.nodes.length; index += 1) {
      const previous = signal.nodes[index - 1]!
      const current = signal.nodes[index]!
      if (previous.x === current.x) continue
      expect(current.visualBounds!.left - previous.visualBounds!.right).toBe(SIGNAL_MIN_WIRE_GAP)
    }
  })

  it('keeps every horizontal causal edge pointing right', () => {
    const signal = projectExecutionPresentation(layoutExecutionGraph(graph()), 'horizontal-signal')
    expect(signal.edges.length).toBeGreaterThan(0)
    for (const edge of signal.edges) {
      expect(edge.to.x).toBeGreaterThan(edge.from.x)
    }
  })
})
