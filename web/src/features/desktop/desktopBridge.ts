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

/** 与 electron/main.ts 的 WindowKind / OpenWindowRequest 保持同构（IPC 载荷，无 class/enum）。 */
export type WindowKind = 'settings' | 'workbench' | 'composer' | 'history' | 'login'
export interface OpenWindowRequest {
  kind: WindowKind
  presetId?: string
  chatId?: string
  source?: 'pet' | 'history' | 'nyxus'
  view?: 'composer' | 'attention' | 'tree'
  focus?: { sourceChatId?: string; interactionId?: string; anchorNodeId?: string }
}

export interface DesktopBridge {
  setMousePassthrough(ignore: boolean): void
  /** desktop 面：打开独立原生窗（设置 / 每预设一工作台窗）。 */
  openWindow(req: OpenWindowRequest): void
  /** 原生窗自绘标题栏 → 原生窗口控制。工作台窗 close = hide（保 WS/run），设置窗 close = destroy。 */
  windowControl(action: 'minimize' | 'maximize' | 'restore' | 'close'): void
  onWindowMaximized(listener: (maximized: boolean) => void): () => void
  onWindowFocused(listener: (focused: boolean) => void): () => void
  /** workbench 面：main 下发的「打开节点树」定位参数。 */
  onWorkbenchFocus(listener: (focus: OpenWindowRequest['focus']) => void): () => void
  /** workbench 面：main 下发的会话切换（重开同 preset 带 chatId）。 */
  onOpenChat(listener: (chatId: string) => void): () => void
  onSurfaceRetarget(listener: (target: { chatId: string; source?: 'pet' | 'history' | 'nyxus'; view?: 'composer' | 'attention' | 'tree' }) => void): () => void
  /** attentionBlink → 任务栏闪烁。 */
  flashFrame(flag: boolean): void
  /** 主题底色回写原生窗（首帧 / resize 边缘兜底）。 */
  setBackgroundColor(color: string): void
  /** 本窗主题切换完成 → 通知 main 广播其它窗（携带目标主题值）。 */
  emitThemeChanged(theme: 'light' | 'dark'): void
  /** 接收 main 广播的跨窗主题同步。 */
  onThemeSet(listener: (theme: 'light' | 'dark') => void): () => void
  emitAuthChanged(data?: unknown): void
  onAuthChanged(listener: (data: unknown) => void): () => void
}

export function desktopBridge(): DesktopBridge | undefined {
  return window.__DESKTOP_BRIDGE__
}
