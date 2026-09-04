import { describe, expect, it } from 'vitest'
import type {
  ExecutionGraph,
  ExecutionNode,
  PositionedExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import { layoutExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionLayout'
import {
  foldContainsErrorMessage,
  projectExecutionPresentation,
  projectExecutionNodePriorities,
  SIGNAL_NODE_SIZES,
  SIGNAL_NODE_VISUAL_KINDS,
  signalNodeFrameVariantFor,
  signalVisualKindFor,
  signalNodeSizeFor,
  signalNodeTierFor,
  toolVisualKindFor,
  SIGNAL_MIN_WIRE_GAP,
} from '../../../src/features/pets/nyxus/graph/executionPresentation'
import { SIGNAL_NODE_ICONS } from '../../../src/features/pets/nyxus/renderer/signalNodeIcons'
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

function forkMergeGraph(): ExecutionGraph {
  const nodes = [
    node('start', 0),
    node('hub', 1),
    node('child-a', 2, 'child-a'),
    node('child-b', 3, 'child-b'),
    node('tail', 4),
  ]
  return {
    rootChatId: 'root',
    nodes,
    edges: [
      {
        id: 'start-hub',
        from: 'start',
        to: 'hub',
        kind: 'sequence',
        orderSlot: 'persistent',
        orderKey: 1,
        sourceChatId: 'root',
        targetChatId: 'root',
      },
      {
        id: 'fork-a',
        from: 'hub',
        to: 'child-a',
        kind: 'spawn',
        orderSlot: 'persistent',
        orderKey: 2,
        sourceChatId: 'root',
        targetChatId: 'child-a',
      },
      {
        id: 'fork-b',
        from: 'hub',
        to: 'child-b',
        kind: 'spawn',
        orderSlot: 'persistent',
        orderKey: 3,
        sourceChatId: 'root',
        targetChatId: 'child-b',
      },
      {
        id: 'merge-a',
        from: 'child-a',
        to: 'tail',
        kind: 'return',
        orderSlot: 'persistent',
        orderKey: 4,
        sourceChatId: 'child-a',
        targetChatId: 'root',
      },
      {
        id: 'merge-b',
        from: 'child-b',
        to: 'tail',
        kind: 'return',
        orderSlot: 'persistent',
        orderKey: 5,
        sourceChatId: 'child-b',
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

/** signalVisualKindFor 的完整定位节点探针（actor/direction/kind 可定制）。 */
function badgeNode(
  kind: ExecutionNode['kind'],
  actor: 'user' | 'agent' | 'system' = 'agent',
  direction: ExecutionNode['direction'] = 'agent-to-user',
): PositionedExecutionNode {
  return {
    ...node('probe', 1),
    kind,
    actor: { kind: actor } as ExecutionNode['actor'],
    direction,
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
    expect(
      signal.nodes.every((entry, index, all) => index === 0 || entry.x >= all[index - 1]!.x),
    ).toBe(true)
    expect(signal.edges.some((edge) => edge.routeX !== undefined)).toBe(true)
    expect(signal.edges.every((edge) => edge.routeY === undefined)).toBe(true)
  })

  it('terminates rounded orthogonal fibers at the rectangular node ports', () => {
    const halfWidth = SIGNAL_NODE_SIZES.structural.width / 2
    const geometry = horizontalExecutionEdgeGeometry(
      { x: 100, y: 40 },
      { x: 300, y: 150 },
      halfWidth,
      190,
    )

    expect(geometry.from.x).toBe(100 + halfWidth)
    expect(geometry.to.x).toBe(300 - halfWidth)
    expect(geometry.control1.x).toBe(190)
    expect(geometry.control2.x).toBe(190)
    expect(geometry.path).toContain(' Q ')
    expect(geometry.samples!.length).toBeGreaterThan(6)
  })

  it('reuses one routing trunk for sibling forks and sibling returns', () => {
    const signal = projectExecutionPresentation(
      layoutExecutionGraph(forkMergeGraph()),
      'horizontal-signal',
    )
    const forks = signal.edges.filter((edge) => edge.id === 'fork-a' || edge.id === 'fork-b')
    const returns = signal.edges.filter((edge) => edge.id === 'merge-a' || edge.id === 'merge-b')

    expect(forks).toHaveLength(2)
    expect(returns).toHaveLength(2)
    expect(forks.every((edge) => edge.routeX !== undefined)).toBe(true)
    expect(returns.every((edge) => edge.routeX !== undefined)).toBe(true)
    expect(new Set(forks.map((edge) => edge.routeX)).size).toBe(1)
    expect(new Set(returns.map((edge) => edge.routeX)).size).toBe(1)
  })

  it('promotes user prompts, final replies and errors without changing canonical facts', () => {
    const nodes = [
      node('start', 0),
      {
        ...node('user', 1),
        actor: { kind: 'user' as const, actorId: 'human' },
        direction: 'user-to-agent' as const,
      },
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

  it('detects an error message hidden inside a process group', () => {
    const errorMessage = {
      ...node('error', 2),
      sourceFact: { termination: { code: 'error' } } as ExecutionNode['sourceFact'],
    }
    const regularMessage = node('regular', 1)
    const fold = {
      ...node('fold', 3),
      kind: 'fold' as const,
      fold: {
        firstNodeId: regularMessage.id,
        lastNodeId: errorMessage.id,
        members: [],
        projectionNodes: [regularMessage, errorMessage],
      },
    }

    expect(foldContainsErrorMessage(fold)).toBe(true)
    expect(foldContainsErrorMessage(regularMessage)).toBe(false)
    expect(
      foldContainsErrorMessage({
        ...fold,
        fold: { ...fold.fold, projectionNodes: [regularMessage] },
      }),
    ).toBe(false)
  })

  it('maps every base node to its visual kind', () => {
    expect(signalVisualKindFor(badgeNode('start', 'system', 'internal'), 'process')).toBe('start')
    expect(signalVisualKindFor(badgeNode('fold', 'agent', 'internal'), 'fold')).toBe('fold')
    expect(signalVisualKindFor(badgeNode('pack', 'agent', 'internal'), 'fold')).toBe('fold')
    expect(signalVisualKindFor(badgeNode('spawn', 'agent', 'internal'), 'process')).toBe('dispatch')
    expect(signalVisualKindFor(badgeNode('dispatch', 'agent', 'internal'), 'process')).toBe(
      'dispatch',
    )
    expect(signalVisualKindFor(badgeNode('return'), 'process')).toBe('return')
    expect(signalVisualKindFor(badgeNode('system', 'system', 'internal'), 'process')).toBe('system')
    expect(signalVisualKindFor(badgeNode('input', 'user', 'user-to-agent'), 'hero-user')).toBe(
      'input',
    )
    expect(signalVisualKindFor(badgeNode('message', 'user', 'user-to-agent'), 'hero-user')).toBe(
      'input',
    )
    expect(signalVisualKindFor(badgeNode('message'), 'hero-final')).toBe('reply')
    expect(signalVisualKindFor(badgeNode('message'), 'hero-error')).toBe('error')
    expect(signalVisualKindFor(badgeNode('message'), 'process')).toBe('process')
    expect(signalVisualKindFor(badgeNode('tool-batch'), 'process')).toBe('tool-generic')
  })

  it('classifies tool batches into built-in tool visual kinds', () => {
    expect(toolVisualKindFor(toolNode('run_command'))).toBe('tool-command')
    expect(toolVisualKindFor(toolNode('read_file'))).toBe('tool-read')
    expect(toolVisualKindFor(toolNode('write_file'))).toBe('tool-write')
    expect(toolVisualKindFor(toolNode('search_codebase'))).toBe('tool-search')
    expect(toolVisualKindFor(toolNode('activate_skill'))).toBe('tool-skill')
    expect(toolVisualKindFor(toolNode('ask_user_question'))).toBe('tool-question')
    expect(toolVisualKindFor(toolNode('spawn_agent'))).toBe('tool-spawn')
    expect(toolVisualKindFor(toolNode('send_to_child'))).toBe('tool-child')
    expect(toolVisualKindFor(toolNode('memory_manage'))).toBe('tool-memory')
    expect(toolVisualKindFor(toolNode('history_recall'))).toBe('tool-memory')
    expect(toolVisualKindFor(toolNode('config_manage'))).toBe('tool-config')
    expect(toolVisualKindFor(toolNode('select_conversation'))).toBe('tool-navigate')
    expect(toolVisualKindFor(toolNode('role_acceptance'))).toBe('tool-role')
    expect(toolVisualKindFor(toolNode('fetch_web_url'))).toBe('tool-web')
    expect(toolVisualKindFor(toolNode('query_database'))).toBe('tool-data')
    expect(toolVisualKindFor(toolNode('git_commit'))).toBe('tool-git')
    expect(toolVisualKindFor(toolNode('schedule_timer'))).toBe('tool-time')
    expect(toolVisualKindFor(toolNode('notify_user'))).toBe('tool-notify')
    expect(toolVisualKindFor(toolNode('custom_unknown'))).toBe('tool-generic')
  })

  it('registers all 29 icon kinds and keeps every icon in one compact square frame', () => {
    expect(SIGNAL_NODE_VISUAL_KINDS).toHaveLength(29)
    expect(Object.keys(SIGNAL_NODE_ICONS).sort()).toEqual([...SIGNAL_NODE_VISUAL_KINDS].sort())
    expect(signalNodeTierFor('start')).toBe('hero')
    expect(signalNodeTierFor('fold')).toBe('structural')
    expect(signalNodeTierFor('tool-command')).toBe('tool')
    expect(signalNodeSizeFor('start')).toEqual(SIGNAL_NODE_SIZES.hero)
    expect(signalNodeSizeFor('process')).toEqual(SIGNAL_NODE_SIZES.structural)
    expect(signalNodeSizeFor('tool-generic')).toEqual(SIGNAL_NODE_SIZES.tool)
    expect(
      new Set(Object.values(SIGNAL_NODE_SIZES).map(({ width, height }) => `${width}x${height}`)),
    ).toEqual(new Set(['40x40']))
    expect(new Set(SIGNAL_NODE_VISUAL_KINDS.map(signalNodeFrameVariantFor))).toEqual(
      new Set(['signal-corners', 'flow-rails', 'action-split', 'reference-notch']),
    )
  })

  it('lays out variable-width columns with the minimum wire gap', () => {
    const signal = projectExecutionPresentation(layoutExecutionGraph(graph()), 'horizontal-signal')
    const columns = [...new Set(signal.nodes.map((entry) => entry.x))].sort((a, b) => a - b)
    expect(columns.length).toBeGreaterThan(1)
    for (let index = 1; index < columns.length; index += 1) {
      const previousRight = Math.max(
        ...signal.nodes
          .filter((node) => node.x === columns[index - 1])
          .map((node) => node.visualBounds!.right),
      )
      const currentLeft = Math.min(
        ...signal.nodes
          .filter((node) => node.x === columns[index])
          .map((node) => node.visualBounds!.left),
      )
      expect(currentLeft - previousRight).toBe(SIGNAL_MIN_WIRE_GAP)
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
