import { onBeforeUnmount, onMounted } from 'vue'
import { desktopBridge } from './desktopBridge'

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
 * - 状态变化才发 IPC（rAF 节流），避免每次 move 刷 IPC。
 *
 * 非 Electron / 无 bridge 环境为 no-op。
 */
export function useDesktopPassthrough(options: UseDesktopPassthroughOptions = {}) {
  const bridge = desktopBridge()
  const hitSelector = options.hitSelector ?? DESKTOP_HIT_SELECTOR
  /** pointerdown 锁：手势进行中强制不穿透。 */
  let locked = false
  /** 上次下发的穿透态，仅变化时发 IPC。 */
  let ignoring = false
  /** 最近一次 pointermove 位置，供 refresh() 无事件重判。 */
  let lastX = -1
  let lastY = -1
  let frame = 0

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

  function evaluate(x: number, y: number): void {
    const hit = document.elementFromPoint(x, y)?.closest(hitSelector) != null
    const shouldIgnore = !hit && !isInteracting()
    if (shouldIgnore === ignoring) return
    ignoring = shouldIgnore
    bridge?.setMousePassthrough(shouldIgnore)
  }

  function onPointerMove(event: PointerEvent): void {
    lastX = event.clientX
    lastY = event.clientY
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      evaluate(lastX, lastY)
    })
  }

  function onPointerDown(event: PointerEvent): void {
    if (document.elementFromPoint(event.clientX, event.clientY)?.closest(hitSelector)) {
      locked = true
      if (ignoring) {
        ignoring = false
        bridge?.setMousePassthrough(false)
      }
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
    evaluate(lastX, lastY)
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
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointerup', releaseLock)
    window.removeEventListener('pointercancel', releaseLock)
  })

  return { lockInteractive: () => (locked = true), refresh }
}
