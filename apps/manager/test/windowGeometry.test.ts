import { describe, expect, it } from 'vitest'
import { fitWindow } from '../ui/windowGeometry'

describe('plugin window geometry', () => {
  it('keeps the requested size when it fits', () => {
    expect(fitWindow({ x: 16, y: 16, width: 960, height: 740 }, { width: 1200, height: 900 }))
      .toEqual({ x: 16, y: 16, width: 960, height: 740 })
  })
  it('keeps a resized or dragged window within the available area', () => {
    expect(fitWindow({ x: 1100, y: -200, width: 700, height: 400 }, { width: 1000, height: 700 }))
      .toEqual({ x: 292, y: 8, width: 700, height: 400 })
  })
  it('fits small screens without enforcing a larger minimum than the screen', () => {
    expect(fitWindow({ x: 16, y: 16, width: 960, height: 740 }, { width: 320, height: 200 }))
      .toEqual({ x: 8, y: 8, width: 304, height: 184 })
  })
  it('enforces usable minimum dimensions on larger screens', () => {
    expect(fitWindow({ x: 8, y: 8, width: 20, height: 20 }, { width: 1000, height: 800 }))
      .toEqual({ x: 8, y: 8, width: 360, height: 240 })
  })
})
