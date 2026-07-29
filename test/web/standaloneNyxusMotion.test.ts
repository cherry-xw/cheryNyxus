import { describe, expect, it } from 'vitest'
import {
  clampNyxusPoint,
  clampNyxusPointerTarget,
} from '../../web/src/features/pets/composables/useStandaloneNyxusMotion'
import {
  createNyxusPointerDrift,
  nyxusAvoidanceTarget,
  nyxusPointerTarget,
  NYXUS_POINTER_DRIFT_MIN_MS,
  NYXUS_POINTER_MAX_SPEED,
  NYXUS_POINTER_MIN_SPEED,
  NYXUS_AVOIDANCE_DISTANCE,
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

  it('uses slow movement legs with a clearly stationary interval', () => {
    expect(NYXUS_POINTER_MIN_SPEED).toBeGreaterThanOrEqual(5)
    expect(NYXUS_POINTER_MAX_SPEED).toBeLessThanOrEqual(12)
    expect(NYXUS_POINTER_DRIFT_MIN_MS).toBeGreaterThanOrEqual(8000)
  })

  it('returns an outward target when a normal pet enters the Nyxus safety halo', () => {
    expect(
      nyxusAvoidanceTarget({ x: 400, y: 300 }, [{ x: 350, y: 270, width: 72, height: 96 }]),
    ).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
    expect(
      nyxusAvoidanceTarget({ x: 400 + NYXUS_AVOIDANCE_DISTANCE, y: 318 }, [
        { x: 364, y: 270, width: 72, height: 96 },
      ]),
    ).toBeUndefined()
  })
})
