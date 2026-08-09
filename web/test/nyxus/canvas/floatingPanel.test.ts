import { describe, expect, it } from 'vitest'
import { constrainFloatingOffset } from '../../../src/features/pets/nyxus/composables/floatingPanel'

describe('floating piano bounds', () => {
  it('clamps every panel edge inside the viewport margin', () => {
    const base = { left: 300, top: 400, width: 680, height: 147 }
    const viewport = { width: 1200, height: 700 }

    expect(constrainFloatingOffset({ x: -10_000, y: -10_000 }, base, viewport)).toEqual({
      x: -292,
      y: -392,
    })
    expect(constrainFloatingOffset({ x: 10_000, y: 10_000 }, base, viewport)).toEqual({
      x: 212,
      y: 145,
    })
  })

  it('centers an oversized panel on the constrained axis', () => {
    expect(
      constrainFloatingOffset(
        { x: 0, y: 0 },
        { left: 20, top: 20, width: 500, height: 80 },
        { width: 320, height: 200 },
      ).x,
    ).toBe(-110)
  })
})
