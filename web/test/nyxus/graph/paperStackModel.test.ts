import { describe, expect, it } from 'vitest'
import type { ExecutionNode } from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  buildPaperStack,
  paperBundleJitter,
  paperBundlePageOffset,
  paperBundlePreferredPageSpan,
  paperChronologicalLayer,
  paperPlacement,
  paperRenderWindow,
  paperScatterForId,
  paperStackLayers,
  paperTitleLayerPlacements,
  paperTitleReadableGap,
  paperVisibleLimits,
} from '../../../src/features/pets/nyxus/paper/paperStackModel'

function node(
  id: string,
  orderKey: number | null,
  createdAt: number,
  kind: ExecutionNode['kind'] = 'message',
): ExecutionNode {
  return {
    id,
    kind,
    rootChatId: 'root',
    sourceChatId: 'root',
    actor: { kind: 'agent' },
    direction: 'internal',
    content: id,
    createdAt,
    status: 'completed',
    main: true,
    orderSlot: orderKey == null ? 'transient' : 'persistent',
    orderKey,
    activeRuns: [],
  }
}

describe('paper stack model', () => {
  it('sorts readable projected nodes and excludes the decorative start node', () => {
    const stack = buildPaperStack(
      [
        node('later', 3, 30),
        node('start', null, 0, 'start'),
        node('first', 1, 10),
        node('second-b', 2, 20),
        node('second-a', 2, 20),
      ],
      (entry) => `Title ${entry.id}`,
    )
    expect(stack.map((entry) => entry.id)).toEqual(['first', 'second-a', 'second-b', 'later'])
    expect(stack.map((entry) => entry.title)).toEqual([
      'Title first',
      'Title second-a',
      'Title second-b',
      'Title later',
    ])
  })

  it('mounts the current paper with seven history and four future neighbours', () => {
    expect(paperRenderWindow(6, 2).indices).toEqual([0, 1, 2, 3, 4, 5])
    expect(paperRenderWindow(12, 0).indices).toEqual([0, 1, 2, 3, 4])
    expect(paperRenderWindow(12, 11).indices).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('orders the visible title rail from newest at the top to oldest at the bottom', () => {
    const layers = paperStackLayers(30, 15)
    const nodes = layers.filter((layer) => layer.kind === 'node')
    const bundles = layers.filter((layer) => layer.kind === 'bundle')

    expect(nodes).toHaveLength(12)
    expect(nodes[0]).toMatchObject({ index: 19, role: 'future', distance: 4, opacity: 0.22 })
    expect(nodes[4]).toMatchObject({ index: 15, role: 'current', opacity: 1 })
    expect(nodes.at(-1)).toMatchObject({ index: 8, role: 'history', distance: 7 })
    expect(bundles).toEqual([
      expect.objectContaining({ role: 'future', hiddenCount: 10, depth: 10 }),
      expect.objectContaining({ role: 'history', hiddenCount: 8, depth: 8 }),
    ])
    expect(layers[0]).toMatchObject({ kind: 'bundle', role: 'future' })
    expect(layers.at(-1)).toMatchObject({ kind: 'bundle', role: 'history' })
    expect(layers).toHaveLength(14)
  })

  it('forms the thickest history bundle on the latest card without rendering every node', () => {
    const layers = paperStackLayers(100, 99)
    const historyBundle = layers.find(
      (layer) => layer.kind === 'bundle' && layer.role === 'history',
    )

    expect(historyBundle).toMatchObject({ hiddenCount: 92, depth: 10 })
    expect(layers.filter((layer) => layer.kind === 'node')).toHaveLength(8)
    expect(layers).toHaveLength(9)
  })

  it('dims future title strips progressively', () => {
    const future = paperStackLayers(12, 3).filter(
      (layer) => layer.kind === 'node' && layer.role === 'future',
    )

    expect(future.map((layer) => [layer.index, layer.opacity])).toEqual([
      [7, 0.22],
      [6, 0.34],
      [5, 0.46],
      [4, 0.58],
    ])
  })

  it('preserves generous click bands near the current title and compresses slowly outward', () => {
    expect([1, 2, 3, 4, 9, 20].map(paperTitleReadableGap)).toEqual([34, 34, 33, 33, 30, 28])
  })

  it('reduces readable titles before their click bands become too narrow', () => {
    expect(paperVisibleLimits(100, 99, 560)).toEqual({ history: 14, future: 0 })
    expect(paperVisibleLimits(100, 99, 300)).toEqual({ history: 7, future: 0 })
    expect(paperVisibleLimits(30, 15, 420)).toEqual({ history: 5, future: 4 })
  })

  it('fills the card bounds while reserving compression for decorative bundles', () => {
    const latestLayers = paperStackLayers(100, 99, 14, 0)
    const latestPlacements = paperTitleLayerPlacements(latestLayers, 560)
    const clickableOffsets = latestPlacements.slice(0, -1).map((placement) => placement.offset)
    const clickableGaps = clickableOffsets
      .slice(1)
      .map((offset, index) => offset - clickableOffsets[index]!)

    expect(latestPlacements[0]?.offset).toBe(0)
    expect(latestPlacements.at(-1)).toEqual({ offset: 513, bundlePageSpan: 32 })
    expect(Math.min(...clickableGaps)).toBeGreaterThanOrEqual(28)

    const middleLayers = paperStackLayers(100, 50, 6, 5)
    const middlePlacements = paperTitleLayerPlacements(middleLayers, 500)
    expect(middlePlacements[0]?.offset).toBe(0)
    expect(middlePlacements.at(-1)?.offset).toBe(457)
    expect(middlePlacements[0]?.bundlePageSpan).toBeGreaterThan(16)
    expect(middlePlacements.at(-1)?.bundlePageSpan).toBeGreaterThan(16)
  })

  it('spreads decorative paper pages with gradually denser spacing', () => {
    const preferredSpan = paperBundlePreferredPageSpan(10)
    const offsets = Array.from({ length: 10 }, (_, index) =>
      paperBundlePageOffset(index, 10, preferredSpan),
    )
    const gaps = offsets.slice(1).map((offset, index) => offset - offsets[index]!)

    expect(preferredSpan).toBe(55)
    expect(offsets).toEqual([0, 10, 19, 27, 34, 40, 45, 49, 52, 55])
    expect(gaps.every((gap, index) => index === 0 || gap <= gaps[index - 1]!)).toBe(true)
  })

  it('offsets each paper deterministically within the jitter bound', () => {
    const a = Array.from({ length: 12 }, (_, index) => paperBundleJitter(index))
    expect(a).toEqual(a)
    expect(paperBundleJitter(3)).toBe(paperBundleJitter(3))
    expect(a.every((jitter) => Math.abs(jitter) <= 6)).toBe(true)
    expect(new Set(a).size).toBeGreaterThan(1)
  })

  it('keeps scatter stable and within the readability limit', () => {
    const first = paperScatterForId('node:stable')
    expect(paperScatterForId('node:stable')).toEqual(first)
    expect(Math.abs(first.x)).toBeLessThanOrEqual(4)
    expect(Math.abs(first.y)).toBeLessThanOrEqual(4)
    expect(Math.abs(first.rotation)).toBeLessThanOrEqual(2)
  })

  it('keeps every paper fixed independently of the current reading position', () => {
    const scatter = { x: 7, y: -5, rotation: -8.4 }
    const placement = paperPlacement(scatter)

    expect(placement).toEqual({ ...scatter, scale: 1 })
  })

  it('layers the earliest paper at the bottom and the latest at the top', () => {
    expect(paperChronologicalLayer(0)).toBeLessThan(paperChronologicalLayer(1))
    expect(paperChronologicalLayer(8)).toBe(9)
  })
})
