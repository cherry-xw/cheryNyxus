import { describe, expect, it } from 'vitest'
import type {
  ExecutionGraph,
  ExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import { layoutExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionLayout'
import {
  projectExecutionPresentation,
  projectExecutionNodePriorities,
  signalLabelBudget,
  SIGNAL_CORRIDOR_MARGIN,
  SIGNAL_MIN_WIRE_GAP,
  SIGNAL_NODE_SIZES,
  SIGNAL_NODE_WIDTH,
  SIGNAL_ROUTE_SLOT_GAP,
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
    expect(signal.edges.some((edge) => edge.routeY !== undefined)).toBe(true)
    expect(signal.edges.every((edge) => edge.routeX === undefined)).toBe(true)
  })

  it('terminates horizontal fibers at the rectangular node ports', () => {
    const geometry = horizontalExecutionEdgeGeometry(
      { x: 100, y: 40 },
      { x: 300, y: 150 },
      SIGNAL_NODE_WIDTH / 2,
      90,
    )

    expect(geometry.from.x).toBe(100 + SIGNAL_NODE_WIDTH / 2)
    expect(geometry.to.x).toBe(300 - SIGNAL_NODE_WIDTH / 2)
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
    expect(projected.find((entry) => entry.id === 'draft')?.protocolCode).toBe('LLM')
  })

  it('spaces variable-width signal columns by their visual boundaries', () => {
    const signal = projectExecutionPresentation(layoutExecutionGraph(graph()), 'horizontal-signal')
    for (let index = 1; index < signal.nodes.length; index += 1) {
      const previous = signal.nodes[index - 1]!
      const current = signal.nodes[index]!
      if (previous.x === current.x) continue
      expect(current.visualBounds!.left).toBeGreaterThan(previous.visualBounds!.right)
    }
    const final = signal.nodes.find((entry) => entry.id === 'tail')!
    expect(final.visualBounds!.right - final.visualBounds!.left).toBe(
      SIGNAL_NODE_SIZES['hero-final'].width,
    )
  })

  it('widens column gaps by the widest node halves plus the minimum wire gap', () => {
    const signal = projectExecutionPresentation(layoutExecutionGraph(graph()), 'horizontal-signal')
    const columns = [...new Set(signal.nodes.map((node) => node.x))].sort((a, b) => a - b)
    for (let index = 1; index < columns.length; index += 1) {
      const previous = signal.nodes.filter((node) => node.x === columns[index - 1])
      const current = signal.nodes.filter((node) => node.x === columns[index])
      const widestPrevious = Math.max(...previous.map((node) => node.visualBounds!.right))
      const narrowestCurrent = Math.min(...current.map((node) => node.visualBounds!.left))
      expect(narrowestCurrent - widestPrevious).toBeGreaterThanOrEqual(SIGNAL_MIN_WIRE_GAP)
    }
  })

  it('keeps every horizontal causal edge pointing right', () => {
    const signal = projectExecutionPresentation(layoutExecutionGraph(graph()), 'horizontal-signal')
    expect(signal.edges.length).toBeGreaterThan(0)
    for (const edge of signal.edges) {
      expect(edge.to.x).toBeGreaterThan(edge.from.x)
    }
  })

  it('truncates signal labels to the per-priority budget', () => {
    expect(signalLabelBudget('process')).toBe(0)
    expect(signalLabelBudget('fold')).toBe(10)
    expect(signalLabelBudget('hero-user')).toBeLessThanOrEqual(22)
    const longContent =
      '一行很长的执行摘要内容用于验证信号网格标签截断预算是否生效并且不会溢出节点矩形'
    const nodes = [
      node('start', 0),
      { ...node('process', 1), direction: 'internal' as const, content: longContent },
      {
        ...node('user', 2),
        actor: { kind: 'user' as const, actorId: 'human' },
        direction: 'user-to-agent' as const,
        content: longContent,
      },
    ]
    const projected = projectExecutionNodePriorities(
      nodes.map((entry, index) => ({ ...entry, x: 0, y: index * 82, lane: 0 })),
    )
    const process = projected.find((entry) => entry.id === 'process')!
    expect(process.summary).toBe('')
    expect(process.protocolCode).toBe('LLM')
    const user = projected.find((entry) => entry.id === 'user')!
    expect(user.summary.length).toBeLessThanOrEqual(signalLabelBudget('hero-user'))
    expect(user.summary.endsWith('…')).toBe(true)
  })

  it('resolves long-edge corridors into non-overlapping slots that clear node bounds', () => {
    // 链式 sequence 边拉开 5 列，再加三条跨多列长边制造走廊竞争。
    const ids = ['n0', 'n1', 'n2', 'n3', 'n4']
    const skipEdges = [
      { id: 'skip-a', from: 'n0', to: 'n3' },
      { id: 'skip-b', from: 'n0', to: 'n4' },
      { id: 'skip-c', from: 'n1', to: 'n4' },
    ]
    const corridorGraph: ExecutionGraph = {
      rootChatId: 'root',
      nodes: ids.map((id, index) => node(id, index)),
      edges: [
        ...ids.slice(1).map((id, index) => ({
          id: `chain-${index}`,
          from: ids[index]!,
          to: id,
          kind: 'sequence' as const,
          orderSlot: 'persistent' as const,
          orderKey: index + 1,
          sourceChatId: 'root',
          targetChatId: 'root',
        })),
        ...skipEdges.map((edge, index) => ({
          ...edge,
          kind: 'sequence' as const,
          orderSlot: 'persistent' as const,
          orderKey: 100 + index,
          sourceChatId: 'root',
          targetChatId: 'root',
        })),
      ],
      diagnostics: [],
    }
    const signal = projectExecutionPresentation(
      layoutExecutionGraph(corridorGraph),
      'horizontal-signal',
    )
    const columnXs = [...new Set(signal.nodes.map((node) => node.x))].sort((a, b) => a - b)
    const columnOf = new Map(
      signal.nodes.map((node) => [node.id, columnXs.indexOf(node.x)] as const),
    )
    const nodeById = new Map(signal.nodes.map((node) => [node.id, node] as const))
    const longEdges = signal.edges.filter(
      (edge) => columnOf.get(edge.to.id)! - columnOf.get(edge.from.id)! > 1,
    )
    expect(longEdges.length).toBe(skipEdges.length)

    // 走廊 y 不得落在被穿越列的任何节点矩形（含膨胀边距）内。
    for (const edge of longEdges) {
      if (edge.routeY === undefined) continue
      const fromColumn = columnOf.get(edge.from.id)!
      const toColumn = columnOf.get(edge.to.id)!
      for (const node of signal.nodes) {
        const column = columnOf.get(node.id)!
        if (column <= fromColumn || column >= toColumn) continue
        const bounds = node.visualBounds!
        expect(
          edge.routeY < bounds.top - SIGNAL_CORRIDOR_MARGIN ||
            edge.routeY > bounds.bottom + SIGNAL_CORRIDOR_MARGIN,
        ).toBe(true)
      }
    }

    // 共享列间隙的长边走廊互不重叠（最小槽位间隔）。
    for (let index = 1; index < longEdges.length; index += 1) {
      const a = longEdges[index - 1]!
      const b = longEdges[index]!
      if (a.routeY === undefined || b.routeY === undefined) continue
      const sharesGap = ids.some((id, position) => {
        if (position === 0) return false
        const column = columnOf.get(id)!
        const between = (edge: typeof a) =>
          columnOf.get(edge.from.id)! < column && column < columnOf.get(edge.to.id)!
        return between(a) && between(b)
      })
      if (sharesGap) {
        expect(Math.abs(a.routeY - b.routeY)).toBeGreaterThanOrEqual(SIGNAL_ROUTE_SLOT_GAP)
      }
    }

    // 长边走廊两端的列位置上不得穿过端点列以外的节点（已在上面覆盖），端点仍指向右方。
    for (const edge of signal.edges) {
      expect(edge.to.x).toBeGreaterThan(edge.from.x)
      expect(nodeById.has(edge.from.id)).toBe(true)
    }
  })
})
