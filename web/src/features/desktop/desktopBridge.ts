/**
 * Electron desktop shell bridge 的类型化门面（消费 preload 注入的 `window.__DESKTOP_BRIDGE__`）。
 *
 * - desktop surface：`setMousePassthrough`（win32 空区域穿透）+ `openConsole`（打开设置/工作台等大界面）；
 * - console surface：`onConsoleNavigate`（消费 main 转发的导航目标）。
 *
 * 非 Electron 环境（浏览器）返回 undefined，调用方需 fallback 到应用内行为。
 */

/** 与 electron/preload.ts 的 ConsoleTarget 保持同构（IPC 载荷，无 class/enum）。 */
export type ConsoleTarget =
  | { target: 'show' }
  | { target: 'settings' }
  | { target: 'workbench'; presetId: string; chatId?: string }
  | { target: 'history'; chatId: string }

export interface DesktopBridge {
  setMousePassthrough(ignore: boolean): void
  openConsole(target: ConsoleTarget): void
  onConsoleNavigate(listener: (target: ConsoleTarget) => void): () => void
  /** console 自绘标题栏 → 原生窗口控制（minimize/close = hide，保 WS 存活）。 */
  consoleWindowControl(action: 'minimize' | 'maximize' | 'restore' | 'close'): void
  onConsoleMaximizeChanged(listener: (maximized: boolean) => void): () => void
}

export function desktopBridge(): DesktopBridge | undefined {
  return window.__DESKTOP_BRIDGE__
}
