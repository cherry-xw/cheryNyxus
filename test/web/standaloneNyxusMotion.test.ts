import { describe, expect, it } from 'vitest'
import {
  clampNyxusPoint,
  clampNyxusPointerTarget,
} from '../../web/src/features/pets/composables/useStandaloneNyxusMotion'
import {
  createNyxusPointerDrift,
  nyxusPointerTarget,
  NYXUS_POINTER_DRIFT_MIN_MS,
  NYXUS_POINTER_MAX_SPEED,
} from '../../web/src/features/pets/motion/nyxusPointerMotion'

describe('standalone Nyxus viewport movement', () => {
  it('keeps the particle cloud and status label inside the viewport', () => {
    expect(clampNyxusPoint({ x: -20, y: -10 }, 1000, 700)).toEqual({ x: 74, y: 74 })
    expect(clampNyxusPoint({ x: 1200, y: 900 }, 1000, 700)).toEqual({ x: 926, y: 608 })
  })

  it('builds a bounded offset target around the latest pointer', () => {
    const values = [0, 0.5]
    const drift = createNyxusPointerDrift(() => values.shift() ?? 0)

    expect(drift.x).toBeCloseTo(32)
    expect(drift.y).toBeCloseTo(0)
    expect(nyxusPointerTarget({ x: 400, y: 300 }, drift)).toEqual({ x: 432, y: 300 })
    expect(clampNyxusPointerTarget({ x: 990, y: 680 }, drift, 1000, 700)).toEqual({
      x: 926,
      y: 608,
    })
  })

  it('keeps pointer pursuit subtle enough for long-running desktop use', () => {
    expect(NYXUS_POINTER_MAX_SPEED).toBeLessThanOrEqual(2)
    expect(NYXUS_POINTER_DRIFT_MIN_MS).toBeGreaterThanOrEqual(8000)
  })
})
