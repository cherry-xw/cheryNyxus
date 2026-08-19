import { describe, expect, it } from 'vitest'
import { clampRectangleToWorkArea, petSurfaceSize } from '../../web/electron/floatingGeometry'

describe('floating window geometry', () => {
  it('clamps to a negative-coordinate display without using a multi-display bounding box', () => {
    expect(
      clampRectangleToWorkArea(
        { x: -2200, y: 900, width: 480, height: 360 },
        { x: -1920, y: 0, width: 1920, height: 1040 },
      ),
    ).toEqual({ x: -1912, y: 672, width: 480, height: 360 })
  })

  it('shrinks a window that is larger than the selected work area', () => {
    expect(
      clampRectangleToWorkArea(
        { x: 0, y: 0, width: 640, height: 420 },
        { x: 100, y: 200, width: 400, height: 300 },
      ),
    ).toEqual({ x: 108, y: 208, width: 384, height: 284 })
  })

  it('uses stable pet count tiers', () => {
    expect(petSurfaceSize(0)).toEqual({ width: 360, height: 300 })
    expect(petSurfaceSize(3)).toEqual({ width: 480, height: 360 })
    expect(petSurfaceSize(12)).toEqual({ width: 640, height: 420 })
  })
})
