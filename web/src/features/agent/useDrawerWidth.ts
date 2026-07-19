import { computed, onMounted, onUnmounted, ref, type Ref, type ComputedRef } from 'vue'

/**
 * useDrawerWidth：抽屉宽度拖拽 + 持久化（localStorage）。
 * - drawerWidth：null → CSS clamp(320,40vw,560) 默认；number → CSS 变量 --drawer-w 覆盖
 * - 边界 [MIN_W=320, maxWidth=innerWidth*2/3]（max=屏幕 2/3）；加载/拖拽/resize 均 clamp
 * - 拖拽：handle pointerdown setPointerCapture（沿用 pet 模块惯例）→ pointermove 改宽 → pointerup 写 localStorage
 * - 失败显性化（规则 12）：读 localStorage 失败回落默认（null）；写失败 console.warn 不阻塞拖拽
 */

const WIDTH_KEY = 'cheryclaw:history-drawer:width'
const MIN_W = 320
const MAX_W_RATIO = 2 / 3

export function useDrawerWidth(): {
  drawerWidth: Ref<number | null>
  panelStyle: ComputedRef<Record<string, string>>
  onHandlePointerDown: (e: PointerEvent) => void
  onHandlePointerMove: (e: PointerEvent) => void
  onHandlePointerUp: (e: PointerEvent) => void
} {
  const maxWidth = (): number => Math.floor(window.innerWidth * MAX_W_RATIO)
  const clampWidth = (w: number): number => Math.max(MIN_W, Math.min(w, maxWidth()))

  function loadWidth(): number | null {
    try {
      const raw = localStorage.getItem(WIDTH_KEY)
      if (!raw) return null
      const w = Number(raw)
      return Number.isFinite(w) && w > 0 ? clampWidth(w) : null
    } catch {
      return null
    }
  }

  function saveWidth(w: number): void {
    try {
      localStorage.setItem(WIDTH_KEY, String(w))
    } catch (e) {
      console.warn('[useDrawerWidth] 写宽度 localStorage 失败:', e)
    }
  }

  const drawerWidth = ref<number | null>(loadWidth())
  const panelStyle = computed<Record<string, string>>(() =>
    drawerWidth.value != null
      ? { '--drawer-w': `${drawerWidth.value}px` }
      : ({} as Record<string, string>),
  )

  // 拖拽态（非响应式：仅拖拽期内部用，宽度变更经 drawerWidth ref 驱动渲染）
  let dragging = false
  let startX = 0
  let startW = 0

  function onHandlePointerDown(e: PointerEvent): void {
    const handle = e.currentTarget as HTMLElement
    const panel = handle.parentElement
    if (!panel) return
    dragging = true
    startX = e.clientX
    startW = panel.offsetWidth
    handle.setPointerCapture(e.pointerId)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }

  function onHandlePointerMove(e: PointerEvent): void {
    if (!dragging) return
    drawerWidth.value = clampWidth(startW - (e.clientX - startX))
  }

  function onHandlePointerUp(e: PointerEvent): void {
    if (!dragging) return
    dragging = false
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    if (drawerWidth.value != null) saveWidth(drawerWidth.value)
  }

  // 窗口缩小：存储宽超当前 2/3 → clamp 保约束
  function onWindowResize(): void {
    if (drawerWidth.value != null) drawerWidth.value = clampWidth(drawerWidth.value)
  }

  onMounted(() => window.addEventListener('resize', onWindowResize))
  onUnmounted(() => {
    window.removeEventListener('resize', onWindowResize)
    // 防御：拖拽中卸载（理论不达）还原 body 样式，避免残留 col-resize
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  })

  return {
    drawerWidth,
    panelStyle,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
  }
}
