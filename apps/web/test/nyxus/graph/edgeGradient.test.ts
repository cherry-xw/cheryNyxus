import { describe, expect, it } from 'vitest'
import {
  gradientPathPoints,
  type GradientEdgeSamples,
} from '../../../src/features/pets/nyxus/graph/edgeGradient'

function edgeFor(samples: GradientEdgeSamples['samples'], length: number): GradientEdgeSamples {
  return { geometry: { from: samples[0]! }, samples, length }
}

describe('gradientPathPoints', () => {
  it('keeps every sample in order when within the segment budget (corners stay intact)', () => {
    const samples = [
      { x: 0, y: 0, distance: 0 },
      { x: 0, y: 20, distance: 20 },
      { x: 20, y: 20, distance: 40 },
    ]
    const points = gradientPathPoints(edgeFor(samples, 40), 12)
    expect(points.map((p) => [p.x, p.y, p.distance])).toEqual([
      [0, 0, 0],
      [0, 20, 20],
      [20, 20, 40],
    ])
  })

  it('decimates over-budget edges but always keeps sharp corner vertices', () => {
    // 折线：起点 → 水平 → 90° 拐角 → 竖直 → 90° 拐角 → 水平 → 终点
    const samples = [
      { x: 0, y: 0, distance: 0 },
      { x: 10, y: 0, distance: 10 },
      { x: 20, y: 0, distance: 20 },
      { x: 30, y: 0, distance: 30 }, // 拐角 1（水平转竖直）
      { x: 30, y: 8, distance: 38 },
      { x: 30, y: 16, distance: 46 },
      { x: 30, y: 24, distance: 54 },
      { x: 30, y: 32, distance: 62 }, // 拐角 2（竖直转水平）
      { x: 42, y: 32, distance: 74 },
      { x: 54, y: 32, distance: 86 },
      { x: 66, y: 32, distance: 98 },
    ]
    const points = gradientPathPoints(edgeFor(samples, 98), 4)
    // 结果被预算封顶
    expect(points.length).toBeLessThanOrEqual(5)
    // 首尾不变
    expect(points[0]).toMatchObject({ x: 0, y: 0 })
    expect(points[points.length - 1]).toMatchObject({ x: 66, y: 32 })
    // 两个 90° 拐角顶点必须保留，不能被直线弦合并掉
    const vertices = points.map((p) => [p.x, p.y])
    expect(vertices).toContainEqual([30, 0])
    expect(vertices).toContainEqual([30, 32])
  })

  it('falls back to the source point when there is no sample', () => {
    const points = gradientPathPoints(
      { geometry: { from: { x: 5, y: 7 } }, samples: [], length: 0 },
      12,
    )
    expect(points).toEqual([{ x: 5, y: 7, distance: 0 }])
  })
})
