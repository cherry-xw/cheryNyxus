import { onBeforeUnmount, onMounted } from 'vue'
import { desktopBridge } from './desktopBridge'
import {
  createDesktopPassthroughState,
  type DesktopHitBounds,
  type DesktopHitProbe,
} from './desktopPassthroughState'

/**
 * 桌面透明窗鼠标穿透命中测试的交互根选择器：
 *
 * - `[data-desktop-hit]`：显式标记的可交互根（PetSprite / NyxusCore / 工具环 / AgentDialog panel / 自有 Teleport 根）；
 * - ElementPlus teleport 弹层兜底：popover / tooltip / select 下拉 / overlay / message 等渲染在
 *   `document.body` 下，`closest('[data-desktop-hit]')` 命中不到，需显式列出。
 */
export const DESKTOP_HIT_SELECTOR = [
  '[data-desktop-hit]',
  '.el-popper',
  '.el-tooltip__popper',
  '.el-select-dropdown',
  '.el-dropdown__popper',
  '.el-overlay',
  '.el-message',
  '.el-notification',
  '.el-picker-panel',
].join(', ')

export interface UseDesktopPassthroughOptions {
  /** 覆盖默认命中选择器（测试用）。 */
  hitSelector?: string
  /** 全局交互态守卫：返回 true 时强制不穿透（如活动输入框聚焦）。 */
  isInteracting?: () => boolean
}

/**
 * desktop surface 鼠标穿透管理。
 *
 * 主进程 `setIgnoreMouseEvents(true, { forward: true })` 后 Windows 仍向 renderer 转发
 * pointermove——本 composable 在 forwarded move 上做 `elementFromPoint` 命中测试：
 *
 * - 命中交互根 → 撤销穿透（鼠标事件进入本窗）；
 * - pointerdown 命中即 `lockInteractive()` 锁定不穿透直到 pointerup/cancel——
 *   拖拽/长按手势中指针可能移过实体边缘，若期间恢复穿透则手势中断丢事件；
 * - 离开实体后延迟 120ms，并在最近命中区域外保留 6px 滞回，避免 pet 边缘来回移动时
 *   连续翻转整屏透明窗的原生穿透态；
 * - 状态变化才发 IPC（rAF 节流），避免每次 move 刷 IPC。
 *
 * 非 Electron / 无 bridge 环境为 no-op。
 */
export function useDesktopPassthrough(options: UseDesktopPassthroughOptions = {}) {
  const bridge = desktopBridge()
  const hitSelector = options.hitSelector ?? DESKTOP_HIT_SELECTOR
  /** pointerdown 锁：手势进行中强制不穿透。 */
  let locked = false
  /** 最近一次 pointermove 位置，供 refresh() 无事件重判。 */
  let lastX = -1
  let lastY = -1
  let frame = 0
  const MAX_HYSTERESIS_TARGET_SIZE = 480

  function isInteracting(): boolean {
    if (locked) return true
    if (options.isInteracting?.()) return true
    // 输入框聚焦时不可穿透：键盘输入期间鼠标移过空白区域不应丢失焦点归属
    const active = document.activeElement
    if (active instanceof HTMLElement) {
      const tag = active.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || active.isContentEditable) return true
    }
    return false
  }

  /**
   * 命中根自身可能没有布局尺寸（PetSprite 的 `.pet-wrap` 即如此），因此从实际命中节点
   * 到根之间选择面积最大的紧凑矩形，作为边界滞回基准。整屏 overlay 不参与滞回，避免
   * 弹层关闭后把整个工作区短暂保留为交互区。
   */
  function hitBounds(element: Element, root: Element): DesktopHitBounds | undefined {
    let current: Element | null = element
    let largest: DesktopHitBounds | undefined
    let largestArea = 0
    while (current) {
      const rect = current.getBoundingClientRect()
      const area = rect.width * rect.height
      if (
        area > largestArea &&
        rect.width <= MAX_HYSTERESIS_TARGET_SIZE &&
        rect.height <= MAX_HYSTERESIS_TARGET_SIZE
      ) {
        largestArea = area
        largest = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      }
      if (current === root) break
      current = current.parentElement
    }
    return largest
  }

  function probe(x: number, y: number): DesktopHitProbe {
    const element = document.elementFromPoint(x, y)
    const root = element?.closest(hitSelector)
    if (!element || !root) return { interactive: false }
    return { interactive: true, bounds: hitBounds(element, root) }
  }

  const passthrough = bridge
    ? createDesktopPassthroughState({
        probe,
        isInteracting,
        setMousePassthrough: (ignore) => bridge.setMousePassthrough(ignore),
      })
    : undefined

  function onPointerMove(event: PointerEvent): void {
    lastX = event.clientX
    lastY = event.clientY
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      passthrough?.move(lastX, lastY)
    })
  }

  function onPointerDown(event: PointerEvent): void {
    if (document.elementFromPoint(event.clientX, event.clientY)?.closest(hitSelector)) {
      locked = true
      passthrough?.forceInteractive()
    }
  }

  function releaseLock(): void {
    if (!locked) return
    locked = false
    // 松手后指针可能已在实体外，立即按当前状态重判一次
    refresh()
  }

  /** 立即按最近指针位置重判（弹层开合、DOM 变化后调用）；指针从未进入过窗口则跳过。 */
  function refresh(): void {
    if (!bridge || lastX < 0) return
    passthrough?.move(lastX, lastY)
  }

  onMounted(() => {
    if (!bridge) return
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', releaseLock, { passive: true })
    window.addEventListener('pointercancel', releaseLock, { passive: true })
  })

  onBeforeUnmount(() => {
    if (frame) cancelAnimationFrame(frame)
    passthrough?.dispose()
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', releaseLock)
    window.removeEventListener('pointercancel', releaseLock)
  })

  return { lockInteractive: () => (locked = true), refresh }
}
