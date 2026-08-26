/**
 * Electron desktop shell bridge 的类型化门面（消费 preload 注入的 `window.__DESKTOP_BRIDGE__`）。
 *
 * - desktop surface：`setMousePassthrough`（win32 空区域穿透）+ `openWindow`（打开设置/工作台独立原生窗）；
 * - settings / workbench surface：`windowControl`（自绘标题栏驱动原生窗）+ `onWindowMaximized`/`onWindowFocused`
 *   + `flashFrame`/`setBackgroundColor`（灰边兜底）+ 跨窗主题同步（`emitThemeChanged`/`onThemeSet`）；
 * - workbench surface 额外：`onWorkbenchFocus`（打开节点树定位）、`onOpenChat`（重开带会话切换）。
 *
 * 非 Electron 环境（浏览器）返回 undefined，调用方需 fallback 到应用内行为。
 */

import type { DesktopBridge, OpenWindowRequest } from '@/domain/shell/desktopBridge'

export type { DesktopBridge, OpenWindowRequest, WindowKind } from '@/domain/shell/desktopBridge'

export function desktopBridge(): DesktopBridge | undefined {
  return window.__DESKTOP_BRIDGE__
}

/**
 * Open the one shared Electron quick-conversation window.
 * Pet and Cherry Nyxus deliberately use this same entry so their native shell,
 * composer controls, retargeting, and keep-alive behavior cannot drift apart.
 * Returns false in the browser, where callers keep their in-page fallback.
 */
export function openQuickComposerWindow(
  chatId: string,
  source: NonNullable<OpenWindowRequest['source']>,
): boolean {
  const bridge = desktopBridge()
  if (!bridge) return false
  bridge.openWindow({ kind: 'composer', chatId, source, view: 'composer' })
  return true
}
