import { expect, it } from 'vitest'
import { initialScatterPosition } from '../../src/features/agent/settings/model/cardScatterLayout'

it('keeps randomized initial cards inside one canvas, allowing partial overlap', () => {
  const canvas = { width: 1000, height: 540 }
  const card = { width: 360, height: 260 }
  const positions = Array.from({ length: 8 }, (_, i) =>
    initialScatterPosition(canvas, card, i, 0.3, 0.7),
  )
  expect(new Set(positions.map((p) => `${p.x},${p.y}`)).size).toBe(8)
  for (const p of positions) {
    expect(p.x).toBeGreaterThanOrEqual(12)
    expect(p.y).toBeGreaterThanOrEqual(12)
    expect(p.x + card.width).toBeLessThanOrEqual(canvas.width)
    expect(p.y + card.height).toBeLessThanOrEqual(canvas.height)
  }
  expect(positions[1]!.x - positions[0]!.x).toBeLessThan(card.width)
  expect(initialScatterPosition(canvas, card, 4, 0.1, 0.2)).not.toEqual(
    initialScatterPosition(canvas, card, 4, 0.9, 0.8),
  )
})

it('bounds cards on a small canvas without producing a scrolling layout', () => {
  const canvas = { width: 320, height: 240 }
  const card = { width: 150, height: 216 }
  for (let i = 0; i < 8; i++) {
    const point = initialScatterPosition(canvas, card, i, 0, 1)
    expect(point.x + card.width).toBeLessThanOrEqual(canvas.width)
    expect(point.y + card.height).toBeLessThanOrEqual(canvas.height)
  }
})
