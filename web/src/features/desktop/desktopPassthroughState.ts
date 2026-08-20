export interface DesktopHitBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface DesktopHitProbe {
  interactive: boolean
  bounds?: DesktopHitBounds
}

export interface DesktopPassthroughStateOptions {
  probe: (x: number, y: number) => DesktopHitProbe
  isInteracting: () => boolean
  setMousePassthrough: (ignore: boolean) => void
  exitDelayMs?: number
  hysteresisPx?: number
}

/**
 * Windows 透明整屏窗的穿透状态机。
 *
 * 进入交互区时立即恢复命中；离开时经过短暂宽限期，并在最近命中区域外保留少量
 * 几何滞回。这样快速划过 pet 边缘不会连续翻转原生窗口的鼠标穿透样式、触发整窗重合成。
 */
export function createDesktopPassthroughState(options: DesktopPassthroughStateOptions) {
  const exitDelayMs = options.exitDelayMs ?? 120
  const hysteresisPx = options.hysteresisPx ?? 6
  const hysteresisExitDelayMs = exitDelayMs + 80
  let ignoring = false
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let lastBounds: DesktopHitBounds | undefined
  let lastX = -1
  let lastY = -1

  function cancelPendingExit(): void {
    if (exitTimer === undefined) return
    clearTimeout(exitTimer)
    exitTimer = undefined
  }

  function apply(ignore: boolean): void {
    if (ignore === ignoring) return
    ignoring = ignore
    options.setMousePassthrough(ignore)
  }

  function withinHysteresis(x: number, y: number): boolean {
    if (!lastBounds) return false
    return (
      x >= lastBounds.left - hysteresisPx &&
      x <= lastBounds.right + hysteresisPx &&
      y >= lastBounds.top - hysteresisPx &&
      y <= lastBounds.bottom + hysteresisPx
    )
  }

  function hasDirectHit(x: number, y: number): boolean {
    const hit = options.probe(x, y)
    if (hit.interactive) {
      lastBounds = hit.bounds
      return true
    }
    return false
  }

  function scheduleExit(delayMs: number): void {
    if (ignoring || exitTimer !== undefined) return
    exitTimer = setTimeout(() => {
      exitTimer = undefined
      // 宽限期内 DOM 可能展开/移动到指针下，执行前必须按最新坐标重新命中。
      if (lastX < 0 || hasDirectHit(lastX, lastY) || options.isInteracting()) return
      // 不让已经消失的弹层/移动后的 pet 留下永久命中区。
      lastBounds = undefined
      apply(true)
    }, delayMs)
  }

  function move(x: number, y: number): void {
    lastX = x
    lastY = y
    if (hasDirectHit(x, y) || options.isInteracting()) {
      cancelPendingExit()
      apply(false)
      return
    }
    // 外层 6px 使用更长的宽限期；最终仍会重新真实命中，避免陈旧矩形永久拦截桌面。
    scheduleExit(withinHysteresis(x, y) ? hysteresisExitDelayMs : exitDelayMs)
  }

  function forceInteractive(): void {
    cancelPendingExit()
    apply(false)
  }

  function dispose(): void {
    cancelPendingExit()
  }

  return { move, forceInteractive, dispose }
}
