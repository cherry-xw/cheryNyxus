import { computed, onScopeDispose, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'

export interface CanvasSize {
  width: number
  height: number
}

export interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasTransform {
  scale: number
  x: number
  y: number
}

export interface CanvasBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface TreeCanvasOptions {
  viewport: () => HTMLElement | null
  contentSize?: () => CanvasSize
  contentBounds?: () => CanvasBounds
  initialFocus?: () => CanvasPoint
  minScale?: number
  maxScale?: number
  padding?: number
  threshold?: number
}

export interface FitToViewOptions {
  animate?: boolean
  duration?: number
  /** 水平对齐：center 居中（默认），right 贴右沿（垂直树靠右贴警戒条，左侧让详情区）。 */
  align?: 'center' | 'right'
}

export function calculateFitTransform(input: {
  viewport: CanvasSize
  content: CanvasSize
  bounds?: CanvasBounds
  focus?: CanvasPoint
  minScale: number
  maxScale: number
  padding: number
  align?: FitToViewOptions['align']
}): CanvasTransform {
  const { viewport, content, focus, minScale, maxScale, padding } = input
  const bounds = input.bounds ?? { minX: 0, minY: 0, maxX: content.width, maxY: content.height }
  const availableWidth = Math.max(1, viewport.width - padding * 2)
  const availableHeight = Math.max(1, viewport.height - padding * 2)
  const idealScale = Math.min(1, availableWidth / content.width, availableHeight / content.height)
  const scale = Math.min(maxScale, Math.max(minScale, idealScale))
  const scaledWidth = content.width * scale
  const scaledHeight = content.height * scale
  const fitsWidth = scaledWidth <= availableWidth
  const fitsHeight = scaledHeight <= availableHeight
  let x: number
  if (input.align === 'right') x = viewport.width - padding - bounds.maxX * scale
  else if (fitsWidth) x = (viewport.width - scaledWidth) / 2 - bounds.minX * scale
  else x = viewport.width / 2 - (focus?.x ?? (bounds.minX + bounds.maxX) / 2) * scale
  const y = fitsHeight
    ? (viewport.height - scaledHeight) / 2 - bounds.minY * scale
    : padding - (focus?.y ?? bounds.minY) * scale
  return { scale, x, y }
}

export function worldToScreen(point: CanvasPoint, transform: CanvasTransform): CanvasPoint {
  return {
    x: transform.x + point.x * transform.scale,
    y: transform.y + point.y * transform.scale,
  }
}

export function screenToWorld(point: CanvasPoint, transform: CanvasTransform): CanvasPoint {
  return {
    x: (point.x - transform.x) / transform.scale,
    y: (point.y - transform.y) / transform.scale,
  }
}

/** 重置动画统一使用的平滑趋近曲线；输入被限制在 0–1，供画布与节点共用。 */
export function treeResetProgress(progress: number): number {
  const bounded = Math.min(1, Math.max(0, progress))
  return 1 - Math.pow(1 - bounded, 3)
}

/**
 * SVG 树画布：内容永远按完整逻辑尺寸布局，视口负责 fit、二维平移与以指针为锚点的缩放。
 * 不与 useDragPan 共用，避免改变钢琴键盘的水平滚动语义。
 */
export function useTreeCanvas(opts: TreeCanvasOptions): {
  scale: Ref<number>
  offsetX: Ref<number>
  offsetY: Ref<number>
  transform: ComputedRef<string>
  dragging: Ref<boolean>
  wasDrag: Ref<boolean>
  userPanned: Ref<boolean>
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  onWheel: (event: WheelEvent) => void
  fitToView: (options?: FitToViewOptions) => void
  cancelAnimation: () => void
  isElementInView: (el: Element, margin?: number) => boolean
  panToElement: (el: Element, align?: 'center' | 'bottom') => void
  followContentEnd: (endY: number) => void
  worldToScreen: (point: CanvasPoint) => CanvasPoint
  screenToWorld: (point: CanvasPoint) => CanvasPoint
  consumeClickAfterDrag: () => boolean
} {
  const minScale = opts.minScale ?? 0.28
  const maxScale = opts.maxScale ?? 2
  const padding = opts.padding ?? 14
  const threshold = opts.threshold ?? 4
  const scale = ref(1)
  const offsetX = ref(0)
  const offsetY = ref(0)
  const dragging = ref(false)
  const wasDrag = ref(false)
  // 用户是否手动平移过；fitToView（reset/刷新/切根）清零以恢复自动跟随。
  const userPanned = ref(false)

  let pointerId = -1
  let startX = 0
  let startY = 0
  let startOffsetX = 0
  let startOffsetY = 0
  let animationFrame = 0
  let pointerTarget: HTMLElement | null = null

  const transform = computed(
    () => `translate(${offsetX.value} ${offsetY.value}) scale(${scale.value})`,
  )

  function viewportSize(): CanvasSize {
    const el = opts.viewport()
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 }
  }
  function contentBounds(): CanvasBounds {
    if (opts.contentBounds) return opts.contentBounds()
    const size = opts.contentSize?.() ?? { width: 0, height: 0 }
    return { minX: 0, minY: 0, maxX: size.width, maxY: size.height }
  }
  function clampScale(value: number): number {
    return Math.min(maxScale, Math.max(minScale, value))
  }
  function applyOffset(x: number, y: number): void {
    offsetX.value = x
    offsetY.value = y
  }
  function cancelAnimation(): void {
    if (!animationFrame) return
    cancelAnimationFrame(animationFrame)
    animationFrame = 0
  }
  function fitToView(options: FitToViewOptions = {}): void {
    const viewport = viewportSize()
    const bounds = contentBounds()
    const content = { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }
    if (viewport.width <= 0 || viewport.height <= 0 || content.width <= 0 || content.height <= 0)
      return
    userPanned.value = false
    const target = calculateFitTransform({
      viewport,
      content,
      bounds,
      focus: opts.initialFocus?.(),
      minScale,
      maxScale,
      padding,
      align: options.align,
    })
    cancelAnimation()
    if (!options.animate) {
      scale.value = target.scale
      offsetX.value = target.x
      offsetY.value = target.y
      return
    }

    const startScale = scale.value
    const startX = offsetX.value
    const startY = offsetY.value
    const startedAt = performance.now()
    const duration = Math.max(1, options.duration ?? 460)
    const step = (now: number): void => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / duration))
      const eased = treeResetProgress(progress)
      scale.value = startScale + (target.scale - startScale) * eased
      offsetX.value = startX + (target.x - startX) * eased
      offsetY.value = startY + (target.y - startY) * eased
      if (progress < 1) animationFrame = requestAnimationFrame(step)
      else animationFrame = 0
    }
    animationFrame = requestAnimationFrame(step)
  }
  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    cancelAnimation()
    const el = event.currentTarget as HTMLElement | null
    el?.setPointerCapture?.(event.pointerId)
    pointerTarget = el
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    startOffsetX = offsetX.value
    startOffsetY = offsetY.value
    dragging.value = true
    wasDrag.value = false
  }
  function onPointerMove(event: PointerEvent): void {
    if (!dragging.value || event.pointerId !== pointerId) return
    const dx = event.clientX - startX
    const dy = event.clientY - startY
    if (Math.hypot(dx, dy) > threshold) {
      wasDrag.value = true
      userPanned.value = true
    }
    applyOffset(startOffsetX + dx, startOffsetY + dy)
  }
  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return
    const el = event.currentTarget as HTMLElement | null
    if (el?.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
    dragging.value = false
    pointerId = -1
    pointerTarget = null
  }
  function onWheel(event: WheelEvent): void {
    cancelAnimation()
    const viewport = opts.viewport()
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    const anchorX = event.clientX - rect.left
    const anchorY = event.clientY - rect.top
    const oldScale = scale.value
    const nextScale = clampScale(oldScale * Math.exp(-event.deltaY * 0.0014))
    if (nextScale === oldScale) return
    const contentX = (anchorX - offsetX.value) / oldScale
    const contentY = (anchorY - offsetY.value) / oldScale
    scale.value = nextScale
    applyOffset(anchorX - contentX * nextScale, anchorY - contentY * nextScale)
  }

  /** 节点元素是否在视口可见区内（含 margin 缓冲）。 */
  function isElementInView(el: Element, margin = 8): boolean {
    const vp = opts.viewport()
    if (!vp) return true
    const r = el.getBoundingClientRect()
    const vr = vp.getBoundingClientRect()
    return (
      r.right >= vr.left + margin &&
      r.left <= vr.right - margin &&
      r.bottom >= vr.top + margin &&
      r.top <= vr.bottom - margin
    )
  }
  /** 平移使节点进入视口：center 居中，bottom 贴下沿。 */
  function panToElement(el: Element, align: 'center' | 'bottom' = 'center'): void {
    const vp = opts.viewport()
    if (!vp) return
    const vr = vp.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const s = scale.value || 1
    const cx = (r.left + r.width / 2 - vr.left - offsetX.value) / s
    const cy = (r.top + r.height / 2 - vr.top - offsetY.value) / s
    const anchorX = vr.width / 2
    const anchorY = align === 'bottom' ? vr.height - padding : vr.height / 2
    applyOffset(anchorX - cx * s, anchorY - cy * s)
  }
  /** 末尾跟随：用户未拖动时，内容下端越界则上移补差使其贴下沿可见（垂直树时间轴向下增长）。 */
  function followContentEnd(endY: number): void {
    if (userPanned.value) return
    const vp = viewportSize()
    if (vp.height <= 0) return
    const endScreenY = offsetY.value + endY * scale.value
    const bottomLimit = vp.height - padding
    if (endScreenY > bottomLimit) {
      applyOffset(offsetX.value, offsetY.value + (bottomLimit - endScreenY))
    }
  }

  function convertWorldToScreen(point: CanvasPoint): CanvasPoint {
    return worldToScreen(point, { scale: scale.value, x: offsetX.value, y: offsetY.value })
  }
  function convertScreenToWorld(point: CanvasPoint): CanvasPoint {
    return screenToWorld(point, { scale: scale.value, x: offsetX.value, y: offsetY.value })
  }
  function consumeClickAfterDrag(): boolean {
    const suppressed = wasDrag.value
    wasDrag.value = false
    return suppressed
  }

  onScopeDispose(() => {
    cancelAnimation()
    if (pointerId >= 0 && pointerTarget?.hasPointerCapture?.(pointerId)) {
      pointerTarget.releasePointerCapture(pointerId)
    }
    dragging.value = false
    pointerId = -1
    pointerTarget = null
  })

  return {
    scale,
    offsetX,
    offsetY,
    transform,
    dragging,
    wasDrag,
    userPanned,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheel,
    fitToView,
    cancelAnimation,
    isElementInView,
    panToElement,
    followContentEnd,
    worldToScreen: convertWorldToScreen,
    screenToWorld: convertScreenToWorld,
    consumeClickAfterDrag,
  }
}
