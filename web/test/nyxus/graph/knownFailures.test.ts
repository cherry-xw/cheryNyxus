import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { effectScope } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '../../../src/services/agentApi'
import { projectExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionGraph'
import { useTreeCanvas } from '../../../src/features/pets/nyxus/composables/useTreeCanvas'

async function realTimelineNodes(): Promise<TimelineNode[]> {
  const fixture = JSON.parse(
    await readFile(resolve('test/fixtures/cp0/real/root-67dabe81.json'), 'utf8'),
  ) as { rootTimeline: { nodes: TimelineNode[] } }
  return fixture.rootTimeline.nodes
}

describe('known failures', () => {
  it.fails('has explicit cross-agent edges in both directions', async () => {
    const nodes = await realTimelineNodes()
    const graph = projectExecutionGraph({
      rootChatId: '67dabe81-00fd-4021-92e0-f65cd061e94f',
      nodes,
      edges: [],
      activeRuns: [],
    })
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
