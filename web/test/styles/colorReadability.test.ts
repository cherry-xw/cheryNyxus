import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { edgeStyle } from '../../src/features/pets/nyxus/graph/edgeStyles'
import { ownerOverlayZIndex, WORKSPACE_WINDOW_Z_INDEX_STEP } from '../../src/styles/overlayLayers'

function rgb(value: string): number[] {
  return value
    .replace('#', '')
    .match(/../g)!
    .map((part) => Number.parseInt(part, 16))
}
function luminance(color: number[]): number {
  return color.reduce((sum, value, index) => {
    const s = value / 255
    return (
      sum +
      (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
    )
  }, 0)
}
function contrast(foreground: string, background: string, alpha = 1): number {
  const bg = rgb(background)
  const mixed = rgb(foreground).map((value, index) => value * alpha + bg[index]! * (1 - alpha))
  const a = luminance(mixed),
    b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('theme foreground/background pairing', () => {
  it('keeps semantic text and solid accent labels readable in both themes', () => {
    const css = readFileSync('web/src/styles/theme.css', 'utf8')
    for (const selector of [':root', "[data-theme='dark']"]) {
      const start = css.indexOf(`${selector} {`)
      const block = css.slice(start, css.indexOf('\n}', start))
      const token = (name: string) => new RegExp(`--${name}: (#[a-f\\d]{6})`, 'i').exec(block)![1]!
      expect(contrast(token('accent-ink'), token('accent'))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('accent'), token('panel'))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('info'), token('surface'))).toBeGreaterThanOrEqual(4.5)
      // Common chips use an 18% accent tint; labels use accent, not accent-ink.
      const soft = rgb(token('accent')).map((n, i) =>
        Math.round(n * 0.18 + rgb(token('panel'))[i]! * 0.82),
      )
      const softHex = `#${soft.map((n) => n.toString(16).padStart(2, '0')).join('')}`
      expect(contrast(token('accent'), softHex)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps primary tree edges visible after alpha blending', () => {
    const palette = readFileSync('web/src/composables/useThemeTokens.ts', 'utf8')
    for (const theme of ['light', 'dark'] as const) {
      const block = palette.split(`${theme}: {`)[1]!.split('},')[0]!
      const alpha = Number(/edgeAlpha: ([\d.]+)/.exec(block)![1])
      for (const kind of [
        'start',
        'spawn',
        'dispatch',
        'return',
        'return-continuation',
        'fork-detail',
        'next',
      ] as const) {
        expect(
          contrast(edgeStyle(kind, theme).color, theme === 'light' ? '#f5f7fc' : '#0b1020', alpha),
          `${theme}/${kind}`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('places teleported menus above their owner but below the next window', () => {
    vi.stubGlobal('getComputedStyle', (element: { zIndex: string }) => element)
    const owner = { zIndex: '512' }
    const anchor = { closest: () => owner } as unknown as HTMLElement
    const z = ownerOverlayZIndex(anchor)
    expect(Number.isInteger(z)).toBe(true)
    expect(z).toBeGreaterThan(512)
    expect(z).toBeLessThan(512 + WORKSPACE_WINDOW_Z_INDEX_STEP)
    vi.unstubAllGlobals()
  })
})
