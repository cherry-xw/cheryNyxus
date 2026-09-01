import { computed, type ComputedRef } from 'vue'
import { useThemeStore } from '@/application/public'

/**
 * JS 侧随主题翻转的色值（Pixi canvas 等非 CSS 场景）。
 * 返回对当前主题响应式的 Pixi 节点树调色板；主题切换时宿主据此重画。
 */
export interface PixiCanvasPalette {
  /** 节点圆底 */
  nodeFill: number
  /** 节点外圈中性环 */
  ringNeutral: number
  /** error 状态环 */
  stateError: number
  /** revoked 状态环 */
  stateRevoked: number
  /** paused 状态环 */
  statePaused: number
  /** 节点标题文字 */
  title: number
  /** termination 标记文字 */
  termination: number
  /** foldCount 数字 */
  foldCount: number
}

const PALETTES: Record<'light' | 'dark', PixiCanvasPalette> = {
  light: {
    nodeFill: 0xf5f7fc,
    ringNeutral: 0x7a5cff,
    stateError: 0xd6455d,
    stateRevoked: 0x9aa0a6,
    statePaused: 0xb7791f,
    title: 0x1b2337,
    termination: 0xd6455d,
    foldCount: 0x1b2337,
  },
  dark: {
    nodeFill: 0x0b1020,
    ringNeutral: 0x7a5cff,
    stateError: 0xff718c,
    stateRevoked: 0x8b8f99,
    statePaused: 0xf6c85f,
    title: 0xe8ecf8,
    termination: 0xffb6c4,
    foldCount: 0xffffff,
  },
}

export const PIXI_CANVAS_PALETTES = PALETTES

export interface ThemeTokens {
  theme: ReturnType<typeof useThemeStore>['theme']
  canvasPalette: ComputedRef<PixiCanvasPalette>
}

/** 主题令牌。canvasPalette 是 computed，随 useThemeStore().theme 变化。 */
export function useThemeTokens(): ThemeTokens {
  const store = useThemeStore()
  const canvasPalette = computed<PixiCanvasPalette>(() => PALETTES[store.theme])
  return { theme: store.theme, canvasPalette }
}
