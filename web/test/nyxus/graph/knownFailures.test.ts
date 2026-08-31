import { effectScope } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { projectExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionGraph'
import { useTreeCanvas } from '../../../src/features/pets/nyxus/composables/useTreeCanvas'
import { topologyMatrixSnapshot } from '../../fixtures/executionGraphFixtures'

describe('graph interaction regressions', () => {
  it('keeps explicit cross-agent edges in both directions', () => {
    const graph = projectExecutionGraph(topologyMatrixSnapshot())
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    const crossAgentEdges = graph.edges.filter((edge) => {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      return from && to && from.sourceChatId !== to.sourceChatId
    })

    expect(crossAgentEdges.length).toBeGreaterThanOrEqual(6)
  })

  it('prevents browser text selection when canvas dragging begins', () => {
    const scope = effectScope()
    const preventDefault = vi.fn()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLElement,
        contentSize: () => ({ width: 400, height: 500 }),
      })
      canvas.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 40,
        clientY: 50,
        currentTarget: { setPointerCapture: vi.fn() },
        preventDefault,
      } as unknown as PointerEvent)
    })
    scope.stop()

    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
