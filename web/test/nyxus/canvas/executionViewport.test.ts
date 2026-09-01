import { describe, expect, it } from 'vitest'
import type {
  ExecutionLayout,
  PositionedExecutionEdge,
  PositionedExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionLayout'
import {
  cameraWorldBounds,
  createExecutionViewportIndex,
  executionWorldBoundsIntersect,
  selectVisibleExecutionItems,
  viewportSelectionContainsCamera,
} from '../../../src/features/pets/nyxus/renderer/executionViewport'

function layoutWithNodes(count: number, withEdges = false): ExecutionLayout {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `node:${index}`,
    x: 0,
    y: 32 + index * 82,
    lane: 0,
  })) as PositionedExecutionNode[]
  const edges = withEdges
    ? (nodes.slice(0, -1).map((from, index) => ({
        id: `edge:${index}`,
        from,
        to: nodes[index + 1]!,
      })) as PositionedExecutionEdge[])
    : []
  return {
    nodes,
    edges,
    width: 200,
    height: count * 82,
    originX: 100,
    bounds: { minX: -100, minY: 0, maxX: 100, maxY: count * 82 },
    laneByChat: new Map(),
  }
}

describe('GPU execution viewport selection', () => {
  it('bounds a horizontal ten-thousand-node Signal scene by x', () => {
    const layout = layoutWithNodes(10_000, true)
    layout.presentation = 'horizontal-signal'
    layout.nodes.forEach((node, index) => {
      node.x = 76 + index * 136
      node.y = 72
    })
    layout.nodes.sort((a, b) => a.x - b.x)
    const visible = selectVisibleExecutionItems(
      layout,
      { scale: 0.32, x: -320_000, y: 100, width: 800, height: 600 },
      new Set(),
      createExecutionViewportIndex(layout),
    )

    expect(visible.nodes.length).toBeGreaterThan(0)
    expect(visible.nodes.length).toBeLessThan(80)
    expect(visible.edges.length).toBeLessThan(80)
  })

  it('keeps mounted primitives bounded for a ten-thousand-node graph', () => {
    const visible = selectVisibleExecutionItems(layoutWithNodes(10_000), {
      scale: 0.32,
      x: 100,
      y: -128_000,
      width: 800,
      height: 600,
    })

    expect(visible.nodes.length).toBeGreaterThan(0)
    expect(visible.nodes.length).toBeLessThan(60)
  })

  it('retains a forced active node outside the viewport', () => {
    const visible = selectVisibleExecutionItems(
      layoutWithNodes(1_000),
      { scale: 1, x: 100, y: 0, width: 800, height: 600 },
      new Set(['node:999']),
    )

    expect(visible.nodes.some((node) => node.id === 'node:999')).toBe(true)
  })

  it('retains a buffered drag selection until the camera approaches its boundary', () => {
    const retained = cameraWorldBounds({ scale: 1, x: 0, y: 0, width: 800, height: 600 }, 800)

    expect(
      viewportSelectionContainsCamera(
        retained,
        { scale: 1, x: 600, y: 0, width: 800, height: 600 },
        160,
      ),
    ).toBe(true)
    expect(
      viewportSelectionContainsCamera(
        retained,
        { scale: 1, x: 660, y: 0, width: 800, height: 600 },
        160,
      ),
    ).toBe(false)
  })

  it('bounds a viewport-sized retained scene while allowing a buffered drag runway', () => {
    const layout = layoutWithNodes(10_000, true)
    const camera = { scale: 0.32, x: 100, y: -128_000, width: 800, height: 600 }
    const retained = selectVisibleExecutionItems(
      layout,
      camera,
      new Set(),
      createExecutionViewportIndex(layout),
      800,
    )

    expect(retained.nodes.length).toBeGreaterThan(70)
    expect(retained.nodes.length).toBeLessThan(110)
  })

  it('detects animation primitives that intersect the live camera bounds', () => {
    const viewport = cameraWorldBounds({ scale: 1, x: 0, y: 0, width: 800, height: 600 }, 120)

    expect(
      executionWorldBoundsIntersect(viewport, { minX: 760, minY: 100, maxX: 900, maxY: 200 }),
    ).toBe(true)
    expect(
      executionWorldBoundsIntersect(viewport, { minX: 930, minY: 100, maxX: 980, maxY: 200 }),
    ).toBe(false)
  })

  it('queries spatial buckets instead of returning every edge while panning', () => {
    const layout = layoutWithNodes(10_000, true)
    const index = createExecutionViewportIndex(layout)
    const visible = selectVisibleExecutionItems(
      layout,
      { scale: 1, x: 100, y: -400_000, width: 800, height: 600 },
      new Set(),
      index,
    )

    expect(visible.edges.length).toBeGreaterThan(0)
    expect(visible.edges.length).toBeLessThan(30)
  })

  it('retains an edge when its reserved route corridor intersects the viewport', () => {
    const layout = layoutWithNodes(2, true)
    layout.nodes[0]!.x = -300
    layout.nodes[1]!.x = -300
    layout.edges[0]!.routeX = 100
    const visible = selectVisibleExecutionItems(
      layout,
      { scale: 1, x: 0, y: 0, width: 200, height: 300 },
      new Set(),
      createExecutionViewportIndex(layout),
      0,
    )

    expect(visible.edges.map((edge) => edge.id)).toContain('edge:0')
  })
})
