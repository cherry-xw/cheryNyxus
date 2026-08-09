import { onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'

/**
 * 横向拖拽平移（NexusPianoStrip + MessageBranchTree 共用）。
 * pointer 驱动 offsetX；溢出时 clamp 到 [viewport-content, 0]；不溢出则不平移。
 * wasDrag 标志区分「拖拽」与「点击」：位移超阈值则后续 click 不触发选键/发声。
 *
 * 调用方：视口元素绑 onPointerDown/Move/Up/Wheel，内轨 transform:translateX(offsetX)。
 *
 * 不用 setPointerCapture：在视口上捕获会把 pointerup target 改写成视口，导致子元素
 * （钢琴键 button）收不到 click（pointerdown/pointerup 共同祖先变成视口），选键失效。
 * 改用 window 级 pointermove/up 监听，pointerdown 时挂、pointerup 时卸，拖拽仍可跨视口。
 */
export interface DragPanOptions {
  /** 视口可见宽（px），用于 clamp。 */
  viewportWidth: () => number
  /** 内容实际宽（px），溢出时才允许平移。 */
  contentWidth: () => number
  /** 视为拖拽的位移阈值（px），默认 4。 */
  threshold?: number
}

export function useDragPan(opts: DragPanOptions): {
  offsetX: Ref<number>
  dragging: Ref<boolean>
  wasDrag: Ref<boolean>
  onPointerDown: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerUp: (e: PointerEvent) => void
  onWheel: (e: WheelEvent) => void
  reset: () => void
} {
  const threshold = opts.threshold ?? 4
  const offsetX = ref(0)
  const dragging = ref(false)
  const wasDrag = ref(false)

  let startX = 0
  let startOffset = 0
  let pointerId = -1

  function minX(): number {
    const vw = opts.viewportWidth()
    const cw = opts.contentWidth()
    if (cw <= vw) return 0
    return vw - cw
  }
  function clamp(v: number): number {
    return Math.min(0, Math.max(minX(), v))
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging.value || e.pointerId !== pointerId) return
    const delta = e.clientX - startX
    if (Math.abs(delta) > threshold) wasDrag.value = true
    offsetX.value = clamp(startOffset + delta)
  }
  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return
    dragging.value = false
    pointerId = -1
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }
  function onPointerDown(e: PointerEvent): void {
    pointerId = e.pointerId
    startX = e.clientX
    startOffset = offsetX.value
    dragging.value = true
    wasDrag.value = false
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }
  function onWheel(e: WheelEvent): void {
    // 水平滚轮直接平移（纵向滚轮也转化，便于触控板/鼠标统一横向）。
    const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    if (delta === 0) return
    offsetX.value = clamp(offsetX.value - delta)
  }
  function reset(): void {
    offsetX.value = 0
    wasDrag.value = false
    dragging.value = false
    pointerId = -1
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }

  // 组件卸载时若仍处于拖拽，清理 window 监听防泄漏。
  onScopeDispose(() => {
    if (!dragging.value) return
    dragging.value = false
    pointerId = -1
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  })

  return { offsetX, dragging, wasDrag, onPointerDown, onPointerMove, onPointerUp, onWheel, reset }
}
