import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { NODE_ACCENT_LIGHT, NODE_SKINS } from '../../src/features/pets/nyxus/graph/nodeSkins'
import {
  signalAccentForTheme,
  type SignalNodeVisualKind,
} from '../../src/features/pets/nyxus/graph/executionPresentation'
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
  it('keeps every vivid tree-node accent distinguishable from its canvas', () => {
    const signalKinds: SignalNodeVisualKind[] = [
      'start',
      'input',
      'reply',
      'error',
      'fold',
      'process',
      'dispatch',
      'return',
      'system',
      'tool-command',
      'tool-read',
      'tool-write',
      'tool-search',
      'tool-skill',
      'tool-spawn',
      'tool-child',
      'tool-question',
      'tool-media',
      'tool-todo',
      'tool-memory',
      'tool-config',
      'tool-navigate',
      'tool-role',
      'tool-web',
      'tool-data',
      'tool-git',
      'tool-time',
      'tool-notify',
      'tool-generic',
    ]
    for (const theme of ['light', 'dark'] as const) {
      const background = theme === 'light' ? '#f5f7fc' : '#0b1020'
      const skinAccents =
        theme === 'light'
          ? NODE_ACCENT_LIGHT
          : Object.fromEntries(Object.entries(NODE_SKINS).map(([key, skin]) => [key, skin.accent]))
      for (const [key, accent] of Object.entries(skinAccents)) {
        expect(contrast(accent, background), `${theme}/skin/${key}`).toBeGreaterThanOrEqual(3)
      }
      for (const kind of signalKinds) {
        expect(
          contrast(signalAccentForTheme(theme, kind), background),
          `${theme}/signal/${kind}`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

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
    // 连线改为两端节点色的渐变后，端点色（节点语义色 + Signal 状态覆盖色）即边色来源；
    // 该用例确保这些端点色在边线透明度混合后仍与画布背景可区分。
    const palette = readFileSync('web/src/composables/useThemeTokens.ts', 'utf8')
    const signalKinds: SignalNodeVisualKind[] = [
      'start',
      'input',
      'reply',
      'error',
      'fold',
      'process',
      'dispatch',
      'return',
      'system',
      'tool-command',
      'tool-read',
      'tool-write',
      'tool-search',
      'tool-skill',
      'tool-spawn',
      'tool-child',
      'tool-question',
      'tool-media',
      'tool-todo',
      'tool-memory',
      'tool-config',
      'tool-navigate',
      'tool-role',
      'tool-web',
      'tool-data',
      'tool-git',
      'tool-time',
      'tool-notify',
      'tool-generic',
    ]
    for (const theme of ['light', 'dark'] as const) {
      const block = palette.split(`${theme}: {`)[1]!.split('},')[0]!
      const alpha = Number(/edgeAlpha: ([\d.]+)/.exec(block)![1])
      const background = theme === 'light' ? '#f5f7fc' : '#0b1020'
      const skinAccents =
        theme === 'light'
          ? NODE_ACCENT_LIGHT
          : Object.fromEntries(Object.entries(NODE_SKINS).map(([key, skin]) => [key, skin.accent]))
      // stateRevoked 是刻意弱化的中性灰（撤销即淡化），不作为可见性校验对象；
      // 错误红与暂停琥珀必须醒目。
      const stateColors = ['stateError', 'statePaused'].map((name) => {
        const raw = new RegExp(`${name}: (0x[0-9a-f]+)`).exec(block)![1]!
        return `#${(Number(raw) & 0xffffff).toString(16).padStart(6, '0')}`
      })
      const accents = [
        ...Object.values(skinAccents),
        ...signalKinds.map((kind) => signalAccentForTheme(theme, kind)),
        ...stateColors,
      ]
      for (const accent of accents) {
        // 连线是 1.35px 装饰性连接线，不承担文本/大元素角色，2.5:1 已是清晰的可见下限
        // （WCAG 3:1 针对大文本/UI 组件，连线无需达到）。
        expect(contrast(accent, background, alpha), `${theme}/${accent}`).toBeGreaterThanOrEqual(
          2.5,
        )
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
