import { describe, expect, it } from 'vitest'
import { DAILY_COLOR_BANDS, dailyCellColor, dailyCellLayout } from '../../src/features/agent/workbench/context-analytics/dailyChart'

describe('daily calendar geometry and colors', () => {
  it('uses the available height without making narrow annual cells square', () => {
    const cell = dailyCellLayout(600, 238, 52)
    expect(cell.height).toBeGreaterThan(cell.width)
    expect(238 - (64 + 7 * cell.pitchY)).toBeLessThan(15)
    expect(cell.pitchX - cell.width).toBe(2)
    expect(cell.pitchY - cell.height).toBe(2)
    expect(cell.radius).toBe(1)
    expect(42 + 52 * cell.pitchX).toBeLessThanOrEqual(600)
  })
  it('allows squares when the annual grid has enough width', () => {
    const cell = dailyCellLayout(1600, 238, 52)
    expect(cell.width).toBe(cell.height)
  })
  it('merges unavailable states and keeps zero separate from the white-to-purple scale', () => {
    const colors = [-3, -2, -1, 0].map(dailyCellColor)
    expect(new Set(colors.slice(0, 3)).size).toBe(1)
    expect(colors[0]).toContain('rgba')
    expect(dailyCellColor(0)).toBe('#d7dee8')
    expect(dailyCellColor(10)).toBe('#a8c7fa')
    expect(dailyCellColor(25_001)).toBe('#6f7fe8')
    for (const value of [-3, -2, -1]) {
      expect(dailyCellColor(value)).not.toBe('#d7dee8')
      expect(dailyCellColor(value)).toBe(DAILY_COLOR_BANDS.find((band) => band.value === -1)!.color)
    }
  })
})
