import { screen, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'

/**
 * 全屏覆盖检测（win32）：koffi（N-API FFI）加载 user32.dll，EnumWindows 枚举顶层
 * 可见窗口，判定是否存在覆盖主屏**完整 bounds**（含任务栏区域）的窗口——区别于
 * 普通最大化窗口（只覆盖 workArea，不含任务栏），从而把「全屏视频 / 游戏」与
 * 「最大化窗口」区分开。
 *
 * 检测到全屏 → 隐藏 desktop 窗（不渲染不占资源，pet/CheryNyxus 让位给全屏应用）；
 * 退出全屏 → 延迟恢复（防窗口切换抖动）。见 docs/web/electron.md「全屏隐藏」。
 *
 * 降级策略：koffi 加载 / user32.dll 加载 / 枚举异常 → console.warn 后返回空操作，
 * 不阻塞主流程。仅 win32 有语义，其他平台直接 no-op。
 */

interface FullscreenGuardOptions {
  /** 轮询间隔（ms），默认 1000 */
  pollInterval?: number
  /** 退出全屏后延迟恢复（ms），默认 500（防窗口切换抖动） */
  restoreDelay?: number
}

const DEFAULT_POLL_INTERVAL = 1000
const DEFAULT_RESTORE_DELAY = 500

/** user32.dll 的 RECT 结构（GetWindowRect 输出，屏幕坐标）。 */
interface WinRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * koffi 运行时的局部接口（FFI 边界类型；实际对象来自 require('koffi')）。
 * koffi 为 CJS 模块，ESM 下经 createRequire 动态加载以支持加载失败降级。
 */
interface KoffiLib {
  func: (
    abi: string,
    name: string,
    result: string,
    params: unknown[],
  ) => (...args: unknown[]) => unknown
}
interface KoffiRuntime {
  load: (name: string) => KoffiLib
  struct: (name: string, fields: Record<string, string>) => unknown
  pointer: (type: unknown) => unknown
  /** 输出参数方向标记（GetWindowRect 的 RECT* 等写回参数） */
  out: (type: unknown) => unknown
  /** 回调函数原型（EnumWindows 的 WNDENUMPROC，作参数需经 pointer() 包裹） */
  proto: (abi: string, name: string, result: string, params: string[]) => unknown
}

export function startFullscreenGuard(
  getDesktopWin: () => BrowserWindow | null,
  opts: FullscreenGuardOptions = {},
): { stop: () => void } {
  // 仅 win32 有语义；其他平台跳过
  if (process.platform !== 'win32') {
    return { stop: () => {} }
  }

  const pollInterval = opts.pollInterval ?? DEFAULT_POLL_INTERVAL
  const restoreDelay = opts.restoreDelay ?? DEFAULT_RESTORE_DELAY

  // ── koffi 动态加载（失败降级） ──────────────────────────────────────
  let koffi: KoffiRuntime
  try {
    const require = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    koffi = require('koffi') as KoffiRuntime
  } catch (cause) {
    console.warn('[fullscreen-guard] koffi 加载失败，全屏隐藏不启用:', cause)
    return { stop: () => {} }
  }

  let user32: KoffiLib
  try {
    user32 = koffi.load('user32.dll')
  } catch (cause) {
    console.warn('[fullscreen-guard] user32.dll 加载失败，全屏隐藏不启用:', cause)
    return { stop: () => {} }
  }

  // ── user32 函数绑定 ────────────────────────────────────────────────
  // BOOL IsWindowVisible(HWND)
  const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr_t'])
  // BOOL GetWindowRect(HWND, LPRECT) —— RECT 指针输出（koffi.out 标记输出参数）
  const RECT = koffi.struct('RECT', {
    left: 'int32',
    top: 'int32',
    right: 'int32',
    bottom: 'int32',
  })
  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', [
    'intptr_t',
    koffi.out(koffi.pointer(RECT)),
  ])
  // BOOL EnumWindows(WNDENUMPROC, LPARAM) —— 回调经 koffi.pointer(proto) 传函数指针；
  // 回调返回 true 继续枚举、false 停止
  const EnumWindowsProc = koffi.proto('__stdcall', 'EnumWindowsProc', 'bool', [
    'intptr_t',
    'intptr_t',
  ])
  const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'bool', [
    koffi.pointer(EnumWindowsProc),
    'intptr_t',
  ])
  // HWND GetForegroundWindow()
  const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'intptr_t', [])

  let hiddenByGuard = false
  let restoreTimer: ReturnType<typeof setTimeout> | null = null

  /** desktop 窗自身 hwnd（Windows 句柄表值，实际 < 2^53，number 安全）。 */
  function selfHwnd(): number | null {
    const win = getDesktopWin()
    if (!win || win.isDestroyed()) return null
    const buf = win.getNativeWindowHandle()
    return buf.length >= 8 ? Number(buf.readBigUInt64LE()) : 0
  }

  /** 判定 hwnd 是否为覆盖主屏完整 bounds（含任务栏）的全屏窗口。 */
  function isFullscreenWindow(hwnd: number, bounds: { x: number; y: number; width: number; height: number }): boolean {
    const self = selfHwnd()
    if (self !== null && hwnd === self) return false
    if (!(IsWindowVisible(hwnd) as boolean)) return false
    const rect: WinRect = { left: 0, top: 0, right: 0, bottom: 0 }
    if (!(GetWindowRect(hwnd, rect) as boolean)) return false
    return (
      rect.left <= bounds.x &&
      rect.top <= bounds.y &&
      rect.right >= bounds.x + bounds.width &&
      rect.bottom >= bounds.y + bounds.height
    )
  }

  /**
   * 是否存在「前台窗口」为全屏覆盖窗口。
   * 必须锚定前台窗口：后台/最小化的最大化窗口 rect 也可能恰好等于屏幕 bounds
   * （GetWindowRect 对最小化窗口返回还原矩形），仅按 rect 判定会误报导致 pet 被误藏。
   */
  function hasForegroundFullscreenWindow(): boolean {
    const bounds = screen.getPrimaryDisplay().bounds
    const fg = GetForegroundWindow() as number
    let found = false
    EnumWindows((hwnd: number) => {
      if (hwnd === fg && isFullscreenWindow(hwnd, bounds)) {
        found = true
        return false // 停止枚举
      }
      return true
    }, 0)
    return found
  }

  function poll(): void {
    const win = getDesktopWin()
    if (!win || win.isDestroyed()) return
    const fullscreen = hasForegroundFullscreenWindow()
    if (fullscreen && !hiddenByGuard) {
      hiddenByGuard = true
      win.hide()
      return
    }
    if (!fullscreen && hiddenByGuard) {
      // 退出全屏 → 延迟恢复（防窗口切换/弹窗短暂不匹配抖动）
      if (restoreTimer) clearTimeout(restoreTimer)
      restoreTimer = setTimeout(() => {
        restoreTimer = null
        const current = getDesktopWin()
        if (!current || current.isDestroyed()) return
        hiddenByGuard = false
        current.showInactive()
      }, restoreDelay)
    }
  }

  const pollTimer = setInterval(poll, pollInterval)
  return {
    stop: () => {
      clearInterval(pollTimer)
      if (restoreTimer) clearTimeout(restoreTimer)
    },
  }
}
