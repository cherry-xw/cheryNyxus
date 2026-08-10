import { describe, expect, it } from 'vitest'
import {
  clampWorkbenchGeometry,
  defaultWorkbenchSize,
} from '../../src/features/agent/dialog/useWorkbenchWindow'

describe('workbench window geometry', () => {
  it('uses a large adaptive default without exceeding the viewport', () => {
    const size = defaultWorkbenchSize(1920, 1080)
    expect(size.width).toBe(1440)
    expect(size.height).toBeGreaterThan(800)
    expect(size.height).toBeLessThanOrEqual(1048)
  })

  it('keeps a restored window and its title bar inside the current viewport', () => {
    const geometry = clampWorkbenchGeometry(
      { x: 4000, y: -900 },
      { width: 1200, height: 760 },
      1440,
      900,
    )
    expect(geometry.position).toEqual({ x: 224, y: 16 })
    expect(geometry.size).toEqual({ width: 1200, height: 760 })
  })

  it('shrinks safely below the normal minimum on narrow viewports', () => {
    const geometry = clampWorkbenchGeometry(
      { x: 100, y: 100 },
      { width: 1200, height: 800 },
      640,
      420,
    )
    expect(geometry.size).toEqual({ width: 608, height: 388 })
    expect(geometry.position).toEqual({ x: 16, y: 16 })
  })
})
