import { onBeforeUnmount, onMounted, ref } from 'vue'
import { desktopBridge } from './desktopBridge'

/**
 * 通用原生窗口外壳 composable（settings / workbench 面共用）。
 *
 * - 驱动原生窗：`control`（最小化/最大化/关闭，工作台窗 close=hide 保 WS/run）、`flash`
 *   （attentionBlink → 任务栏闪烁）、`applyBackground`（主题底色回写，首帧 / resize 边缘兜底）
 * - 监听原生态回推：`onWindowMaximized`（双击标题栏 / Win+↑ / 拖边缘 → 图标切换）、`onWindowFocused`
 *
 * 非 Electron（浏览器）下全部 no-op，调用方可无条件使用。
 */
export function useWindowFrame() {
  const bridge = desktopBridge()
  const maximized = ref(false)
  const focused = ref(true)
  let cleanupMaximized: (() => void) | undefined
  let cleanupFocused: (() => void) | undefined

  onMounted(() => {
    if (!bridge) return
    cleanupMaximized = bridge.onWindowMaximized((value) => {
      maximized.value = value
    })
    cleanupFocused = bridge.onWindowFocused((value) => {
      focused.value = value
    })
  })
  onBeforeUnmount(() => {
    cleanupMaximized?.()
    cleanupFocused?.()
  })

  function control(action: 'minimize' | 'maximize' | 'restore' | 'close'): void {
    bridge?.windowControl(action)
  }
  function toggleMaximize(): void {
    control(maximized.value ? 'restore' : 'maximize')
  }
  function flash(flag: boolean): void {
    bridge?.flashFrame(flag)
  }
  function applyBackground(color: string): void {
    bridge?.setBackgroundColor(color)
  }

  return { bridge, maximized, focused, control, toggleMaximize, flash, applyBackground }
}

/**
 * 灰边修复核心：对 Electron 原生窗（settings/workbench）锁定根画布 color-scheme:light。
 *
 * Element Plus dark css-vars 会设 `html.dark { color-scheme: dark }`，Chromium 在 dark
 * color-scheme 下给根画布涂系统深灰 → 窗口四周灰边。锁 light 后主题 token 仍正常切换，
 * 只锁画布底色（与 DesktopSurface 的 ROOT_COLOR_SCHEME 同机制，扩展到全部 Electron 窗）。
 *
 * 同时给 `<html>` 加 `window-surface` class，theme.css 据此给根画布铺 `var(--bg)` 兜底
 * （窗口边缘 / 圆角 / 拖拽残影显示主题底色而非系统灰/白）。
 */
export function lockWindowRootColorScheme(): void {
  const root = document.documentElement
  root.style.colorScheme = 'light'
  root.classList.add('window-surface')
}
