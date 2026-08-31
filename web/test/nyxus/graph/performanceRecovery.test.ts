import { readComponentSource } from '../../helpers/componentSource'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TimelineNode } from '../../../src/services/agentApi'
import { projectPersistentExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionGraph'
import { createIncrementalExecutionLayout } from '../../../src/features/pets/nyxus/graph/executionLayout'
import { selectVisibleCrtIds } from '../../../src/features/pets/nyxus/graph/crtLayout'
import { invalidGraphSnapshot } from '../../fixtures/executionGraphFixtures'

function node(index: number): TimelineNode {
  return {
    id: `message:${index}`,
    rootChatId: 'root-performance',
    sourceChatId: 'root-performance',
    kind: 'message',
    actor: { kind: 'agent', chatId: 'root-performance' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: `message ${index}`,
    orderKey: index + 1,
    createdAt: index + 1,
    updatedAt: index + 1,
    status: 'committed',
  }
}

describe('performance and recovery boundaries', () => {
  it('keeps streaming-only updates on the incremental layout fast path', () => {
    const snapshot = {
      rootChatId: 'root-performance',
      nodes: Array.from({ length: 2_000 }, (_, index) => node(index)),
      edges: Array.from({ length: 1_999 }, (_, index) => ({
        id: `edge:${index}`,
        rootChatId: 'root-performance',
        fromNodeId: `message:${index}`,
        toNodeId: `message:${index + 1}`,
        kind: 'sequence' as const,
        orderKey: 4_000 + index,
        sourceChatId: 'root-performance',
        targetChatId: 'root-performance',
      })),
      activeRuns: [],
    }
    const graph = projectPersistentExecutionGraph(snapshot)
    const engine = createIncrementalExecutionLayout()
    const initial = engine.layout(graph)
    const startedAt = performance.now()

    for (let index = 0; index < 120; index += 1) {
      const last = graph.nodes.at(-1)!
      engine.layout({
        ...graph,
        nodes: [...graph.nodes.slice(0, -1), { ...last, content: `stream patch ${index}` }],
      })
    }

    const elapsedMs = performance.now() - startedAt
    expect(engine.recomputations()).toBe(1)
    expect(engine.layout(graph).nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      initial.nodes.map(({ id, x, y }) => ({ id, x, y })),
    )
    expect(elapsedMs).toBeLessThan(1_500)
    const crtVisibility = selectVisibleCrtIds(
      Array.from({ length: 8 }, (_, index) => ({
        id: `crt:${index}`,
        actionable: false,
        pinned: false,
        order: index,
      })),
      5,
    )
    expect(crtVisibility.visible.size).toBe(5)
    expect(crtVisibility.hiddenPassive).toBe(3)
  })

  it('recomputes once when topology grows and preserves existing coordinates', () => {
    const graph = projectPersistentExecutionGraph({
      rootChatId: 'root-performance',
      nodes: [node(0), node(1)],
      edges: [],
      activeRuns: [],
    })
    const engine = createIncrementalExecutionLayout()
    const first = engine.layout(graph)
    const next = engine.layout({
      ...graph,
      nodes: [...graph.nodes, { ...graph.nodes.at(-1)!, id: 'message:2', orderKey: 3 }],
    })

    expect(engine.recomputations()).toBe(2)
    expect(next.nodes.find((item) => item.id === 'message:0')).toMatchObject(
      first.nodes.find((item) => item.id === 'message:0')!,
    )
  })

  it('renders a recoverable graph and reports dangling facts instead of throwing', () => {
    const graph = projectPersistentExecutionGraph(invalidGraphSnapshot())
    expect(graph.nodes.some((item) => item.kind === 'start')).toBe(true)
    expect(graph.diagnostics).toEqual([
      expect.objectContaining({ code: 'dangling-edge', factId: 'edge-missing-target' }),
    ])
    expect(() => createIncrementalExecutionLayout().layout(graph)).not.toThrow()
  })

  it('keeps keyboard, aria, diagnostics and reduced-motion contracts in the tree renderer', async () => {
    const source = await readComponentSource(
      resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'),
      'utf8',
    )
    expect(source).toContain(':aria-label="nodeAriaLabel(node)"')
    expect(source).toContain('class="gpu-node-hit-target"')
    expect(source).toContain('class="tree-gpu-surface"')
    expect(source).toContain('@keydown.down.prevent.stop')
    expect(source).toContain('@keydown.home.prevent.stop')
    expect(source).toContain('class="graph-diagnostic" role="alert"')
    const renderer = await readComponentSource(
      resolve('web/src/features/pets/nyxus/renderer/ExecutionGraphPixiRenderer.ts'),
      'utf8',
    )
    expect(renderer).toContain("matchMedia('(prefers-reduced-motion: reduce)')")
  })
})
