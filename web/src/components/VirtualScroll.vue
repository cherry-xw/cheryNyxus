<script setup lang="ts" generic="T">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from 'vue'

type ItemKey = string | number
type ScrollAlign = 'start' | 'center' | 'end'

const DEFAULT_ESTIMATED_SIZE = 120
const OVERSCAN_PX = 600

const props = withDefaults(
  defineProps<{
    /** 要虚拟化渲染的数据。 */
    items: readonly T[]
    /** 项的稳定唯一标识。高度缓存以此为索引，离屏后仍会保留。 */
    itemKey: (item: T, index: number) => ItemKey
    /** 尚未量测时的单项高度估算。 */
    estimateSize?: (item: T, index: number) => number
    /** 可视范围不足时最少渲染的条数。 */
    defaultRenderCount?: number
  }>(),
  {
    estimateSize: () => DEFAULT_ESTIMATED_SIZE,
    defaultRenderCount: 12,
  },
)

const containerRef = ref<HTMLElement | null>(null)
const viewportHeight = ref(0)
const scrollTop = ref(0)
const measuredSizes = reactive(new Map<ItemKey, number>())
const itemObservers = new Map<ItemKey, { element: HTMLElement; observer?: ResizeObserver }>()
const pendingMeasurements = new Map<ItemKey, HTMLElement>()
let scrollRafId = 0
let measureRafId = 0
let containerResizeObserver: ResizeObserver | undefined

// thumb 拖拽状态（Pointer Events + setPointerCapture，拖出 thumb 区域仍收事件）
const isDraggingThumb = ref(false)
let dragStartClientY = 0
let dragStartScrollTop = 0
let dragPointerId = -1

const itemKeys = computed<ItemKey[]>(() =>
  props.items.map((item, index) => props.itemKey(item, index)),
)
const indexByKey = computed(() => new Map(itemKeys.value.map((key, index) => [key, index])))

function getItemSize(index: number): number {
  const key = itemKeys.value[index]!
  const measuredSize = measuredSizes.get(key)
  return measuredSize ?? props.estimateSize(props.items[index]!, index)
}

const offsets = computed<number[]>(() => {
  const values = new Array<number>(props.items.length + 1)
  values[0] = 0
  for (let index = 0; index < props.items.length; index += 1) {
    values[index + 1] = values[index]! + getItemSize(index)
  }
  return values
})

const totalSize = computed(() => offsets.value[props.items.length] ?? 0)

/** 某 index 项的累计 offset（px）。未量测项为估算，随 ResizeObserver 量测渐近准确。 */
function offsetOf(index: number): number {
  if (index < 0 || index >= props.items.length) return 0
  return offsets.value[index] ?? 0
}

/** 某 index 项在列表中的垂直比例（0-1），按条目序号而非高度累加。
 *  关键：不依赖 offsets（未量测项为估算，滚动时随 ResizeObserver 持续重算 → minimap 标记抖动）。
 *  改用 idx/length 后位置稳定零抖动。代价：标记按「第几条」分布而非「内容多高」，
 *  与 thumb（按 scrollTop/maxScrollTop 高度比例）有轻微错位，属 minimap 锚点惯例。
 *  点击跳转精度不受影响（onRailJump→scrollToIndex 迭代校正按高度精确落位）。 */
function ratioOf(index: number): number {
  const count = props.items.length
  if (count <= 0) return 0
  return Math.min(1, Math.max(0, index / count))
}

// 自定义滚动条 thumb 几何（依赖 viewportHeight / scrollTop / totalSize）
const trackHeight = computed(() => viewportHeight.value)
const thumbHeight = computed(() => {
  const total = Math.max(1, totalSize.value)
  const ratio = viewportHeight.value / total
  return Math.max(24, Math.floor(ratio * viewportHeight.value))
})
const thumbTop = computed(() => {
  const maxScrollTop = totalSize.value - viewportHeight.value
  if (maxScrollTop <= 0) return 0
  const ratio = Math.min(1, Math.max(0, scrollTop.value / maxScrollTop))
  return Math.floor(ratio * (viewportHeight.value - thumbHeight.value))
})

function findFirstVisibleIndex(offset: number): number {
  let low = 0
  let high = props.items.length
  const values = offsets.value
  while (low < high) {
    const middle = (low + high) >> 1
    if (values[middle + 1]! <= offset) low = middle + 1
    else high = middle
  }
  return low
}

function findEndExclusive(offset: number): number {
  let low = 0
  let high = props.items.length
  const values = offsets.value
  while (low < high) {
    const middle = (low + high) >> 1
    if (values[middle]! < offset) low = middle + 1
    else high = middle
  }
  return low
}

const renderedIndices = computed<number[]>(() => {
  const itemCount = props.items.length
  if (itemCount === 0) return []

  const start = findFirstVisibleIndex(Math.max(0, scrollTop.value - OVERSCAN_PX))
  const visibleEnd = findEndExclusive(scrollTop.value + viewportHeight.value + OVERSCAN_PX)
  const minEnd = start + Math.max(1, Math.floor(props.defaultRenderCount))
  const endExclusive = Math.min(itemCount, Math.max(visibleEnd, minEnd))

  return Array.from({ length: endExclusive - start }, (_, offset) => start + offset)
})

function syncScrollTop(): void {
  const element = containerRef.value
  if (element && scrollTop.value !== element.scrollTop) scrollTop.value = element.scrollTop
}

function onScroll(): void {
  if (scrollRafId !== 0) return
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = 0
    syncScrollTop()
  })
}

function flushMeasurements(): void {
  measureRafId = 0
  const element = containerRef.value
  const previousOffsets = offsets.value
  const currentScrollTop = element?.scrollTop ?? scrollTop.value
  let anchorAdjustment = 0

  pendingMeasurements.forEach((itemElement, key) => {
    if (!itemElement.isConnected) return
    const index = indexByKey.value.get(key)
    if (index === undefined) return

    const nextSize = itemElement.getBoundingClientRect().height
    const previousSize = getItemSize(index)
    if (Math.abs(nextSize - previousSize) <= 0.5) return

    // 仅补偿完整位于视口上方的项；视口中的内容尺寸变化应自然呈现。
    if (previousOffsets[index + 1]! <= currentScrollTop + 0.5) {
      anchorAdjustment += nextSize - previousSize
    }
    measuredSizes.set(key, nextSize)
  })
  pendingMeasurements.clear()

  if (element && anchorAdjustment !== 0) {
    element.scrollTop = Math.max(0, currentScrollTop + anchorAdjustment)
    syncScrollTop()
  }
}

function scheduleMeasurement(key: ItemKey, element: HTMLElement): void {
  pendingMeasurements.set(key, element)
  if (measureRafId !== 0) return
  measureRafId = requestAnimationFrame(flushMeasurements)
}

function registerItem(key: ItemKey, element: Element | ComponentPublicInstance | null): void {
  const previous = itemObservers.get(key)
  if (!element) {
    previous?.observer?.disconnect()
    itemObservers.delete(key)
    pendingMeasurements.delete(key)
    return
  }

  if (!(element instanceof HTMLElement)) return
  const htmlElement = element
  if (previous?.element === htmlElement) return

  previous?.observer?.disconnect()
  const observer =
    typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(() => scheduleMeasurement(key, htmlElement))
  observer?.observe(htmlElement)
  itemObservers.set(key, { element: htmlElement, observer })
  scheduleMeasurement(key, htmlElement)
}

const SCROLL_CORRECT_THRESHOLD_PX = 4 // 收敛阈值
const SCROLL_CORRECT_MAX_ITER = 4 // 硬上限（规则 6 预算），防估算偏差大时死循环

/** 等下一帧 rAF。 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** 按 align 计算 index 项的目标 scrollTop（基于当前 offsets，未量测项为估算）。 */
function computeTargetScrollTop(index: number, align: ScrollAlign, element: HTMLElement): number {
  const itemTop = offsets.value[index]!
  const itemSize = offsets.value[index + 1]! - itemTop
  let target = itemTop
  if (align === 'center') target = itemTop - element.clientHeight / 2 + itemSize / 2
  if (align === 'end') target = itemTop - element.clientHeight + itemSize
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
  return Math.min(Math.max(0, target), maxScrollTop)
}

// scrollToIndex 迭代校正：动态高度虚拟列表首次跳转目标项可能未量测 → offsets 估算偏差。
// 每跳一次触发目标区域渲染 + ResizeObserver 量测 → 等 2 帧让 flushMeasurements 刷新 offsets →
// 复算 target，直到 |Δtarget| < 阈值收敛或达上限。迭代全程用 auto（smooth 多次叠加抖动），
// 仅收敛/末次按请求补一次 smooth 收尾。
async function scrollToIndex(
  index: number,
  options: { align?: ScrollAlign; behavior?: ScrollBehavior } = {},
): Promise<void> {
  await nextTick()
  const element = containerRef.value
  if (!element || index < 0 || index >= props.items.length) return

  const align = options.align ?? 'start'
  const requestedBehavior: ScrollBehavior = options.behavior ?? 'auto'

  let lastTarget = Number.NaN
  let converged = false
  for (let iter = 0; iter < SCROLL_CORRECT_MAX_ITER; iter += 1) {
    const target = computeTargetScrollTop(index, align, element)
    // 第二次起比对收敛
    if (!Number.isNaN(lastTarget) && Math.abs(target - lastTarget) < SCROLL_CORRECT_THRESHOLD_PX) {
      converged = true
      if (requestedBehavior === 'smooth') {
        element.scrollTo({ top: target, behavior: 'smooth' })
      }
      break
    }
    element.scrollTo({ top: target, behavior: 'auto' })
    lastTarget = target
    // 第 1 帧：scrollTo → renderedIndices 重算 → 新 DOM 挂载 → ResizeObserver 入队
    // 第 2 帧：flushMeasurements 跑完 → measuredSizes 更新 → offsets 重算
    await nextFrame()
    await nextFrame()
  }
  // 达上限未收敛：停在最准位置，按请求 smooth 收尾
  if (!converged && requestedBehavior === 'smooth') {
    const target = computeTargetScrollTop(index, align, element)
    element.scrollTo({ top: target, behavior: 'smooth' })
  }
}

function scrollToEnd(behavior: ScrollBehavior = 'auto'): void {
  void nextTick(() => {
    const element = containerRef.value
    if (!element) return
    const max = Math.max(0, element.scrollHeight - element.clientHeight)
    element.scrollTo({ top: max, behavior })
    // auto 模式下同步 scrollTop（供 scroll 事件回环）；smooth 让浏览器原生处理，无需 sync
    if (behavior === 'auto') syncScrollTop()
  })
}

// thumb 拖拽：按下捕获指针，move 按比例同步 scrollTop，up 释放
function onThumbPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  e.stopPropagation() // 阻止冒泡到 track 跳比例
  isDraggingThumb.value = true
  dragStartClientY = e.clientY
  dragStartScrollTop = scrollTop.value
  dragPointerId = e.pointerId
  ;(e.currentTarget as HTMLElement).setPointerCapture(dragPointerId)
  window.addEventListener('pointermove', onThumbPointerMove)
  window.addEventListener('pointerup', onThumbPointerUp)
}

function onThumbPointerMove(e: PointerEvent): void {
  if (!isDraggingThumb.value) return
  const element = containerRef.value
  if (!element) return
  const maxScrollTop = element.scrollHeight - element.clientHeight
  if (maxScrollTop <= 0) return
  const draggable = Math.max(1, viewportHeight.value - thumbHeight.value)
  const delta = e.clientY - dragStartClientY
  const next = dragStartScrollTop + (delta / draggable) * maxScrollTop
  element.scrollTop = Math.min(Math.max(0, next), maxScrollTop)
  syncScrollTop()
}

function onThumbPointerUp(): void {
  isDraggingThumb.value = false
  const element = containerRef.value
  if (element && dragPointerId >= 0) {
    try {
      element.releasePointerCapture(dragPointerId)
    } catch {
      // 指针已释放，忽略
    }
  }
  dragPointerId = -1
  window.removeEventListener('pointermove', onThumbPointerMove)
  window.removeEventListener('pointerup', onThumbPointerUp)
}

// 轨道空白点击：按点击位置比例滚，让点击点对齐 thumb 中央
function onTrackPointerDown(e: PointerEvent): void {
  if (e.target !== e.currentTarget) return // 仅轨道本体，非 thumb/标记
  if (e.button !== 0) return
  const element = containerRef.value
  if (!element) return
  const trackRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (e.clientY - trackRect.top) / trackRect.height
  const maxScrollTop = element.scrollHeight - element.clientHeight
  const target = ratio * element.scrollHeight - element.clientHeight / 2
  element.scrollTo({ top: Math.min(Math.max(0, target), maxScrollTop), behavior: 'smooth' })
}

watch(itemKeys, (keys) => {
  const validKeys = new Set(keys)
  measuredSizes.forEach((_, key) => {
    if (!validKeys.has(key)) measuredSizes.delete(key)
  })
})

onMounted(() => {
  const element = containerRef.value
  if (!element) return
  viewportHeight.value = element.clientHeight
  if (typeof ResizeObserver === 'undefined') return
  containerResizeObserver = new ResizeObserver(([entry]) => {
    const height = entry?.contentRect.height ?? 0
    if (height > 0 && viewportHeight.value !== Math.floor(height)) {
      viewportHeight.value = Math.floor(height)
    }
  })
  containerResizeObserver.observe(element)
})

onBeforeUnmount(() => {
  if (scrollRafId) cancelAnimationFrame(scrollRafId)
  if (measureRafId) cancelAnimationFrame(measureRafId)
  containerResizeObserver?.disconnect()
  itemObservers.forEach(({ observer }) => observer?.disconnect())
  itemObservers.clear()
  pendingMeasurements.clear()
  // 拖拽中卸载兜底：移除 window 监听，防残留
  if (isDraggingThumb.value) {
    window.removeEventListener('pointermove', onThumbPointerMove)
    window.removeEventListener('pointerup', onThumbPointerUp)
  }
})

function scrollToOffset(offset: number, behavior: ScrollBehavior = 'auto'): void {
  const element = containerRef.value
  if (!element) return
  const max = element.scrollHeight - element.clientHeight
  element.scrollTo({ top: Math.min(Math.max(0, offset), max), behavior })
}

function scrollToRatio(ratio: number, behavior: ScrollBehavior = 'auto'): void {
  const element = containerRef.value
  if (!element) return
  const max = element.scrollHeight - element.clientHeight
  element.scrollTo({ top: Math.min(Math.max(0, ratio), 1) * max, behavior })
}

defineExpose({
  scrollToEnd,
  scrollToIndex,
  offsetOf,
  ratioOf,
  scrollToOffset,
  scrollToRatio,
  // 当前 scrollTop / viewportHeight（reactive ref；外部读 .value 以判断视口位置，
  // 实现「滚到视口外上一条/下一条 user 消息」需要视口高度）
  scrollTop,
  viewportHeight,
})
</script>

<template>
  <div class="virtual-scroll">
    <!-- 滚动视口（实际滚动元素）：ref/scroll/量测都基于此 -->
    <div ref="containerRef" class="virtual-scroll-viewport" @scroll.passive="onScroll">
      <div class="virtual-scroll-content" :style="{ height: `${totalSize}px` }">
        <div
          v-for="index in renderedIndices"
          :key="itemKeys[index]!"
          :ref="(element) => registerItem(itemKeys[index]!, element)"
          class="virtual-scroll-item"
          :style="{ transform: `translate3d(0, ${Math.round(offsets[index] ?? 0)}px, 0)` }"
        >
          <slot :item="items[index]" :index="index" />
        </div>
      </div>
    </div>

    <!-- 自定义滚动条层：外层 flex 子（不随 viewport 滚动）；容器透传，子元素各自接收点击 -->
    <div class="vs-scrollbar" aria-hidden="true">
      <div class="vs-track" @pointerdown="onTrackPointerDown">
        <!-- 父组件渲染的 minimap 标记点（user 消息等业务标记），VirtualScroll 仅暴露位置→比例能力 -->
        <slot
          name="scrollbar-mark"
          :track-height="trackHeight"
          :total-size="totalSize"
          :scroll-top="scrollTop"
          :viewport-height="viewportHeight"
          :offset-of="offsetOf"
          :ratio-of="ratioOf"
        />
        <!-- thumb（VirtualScroll 自维护几何与拖拽） -->
        <div
          class="vs-thumb"
          :class="{ 'is-dragging': isDraggingThumb }"
          :style="{ height: `${thumbHeight}px`, transform: `translateY(${thumbTop}px)` }"
          @pointerdown="onThumbPointerDown"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-scroll {
  position: relative;
  min-height: 0;
  display: flex; /* viewport + 滚动条并排；滚动条不随 viewport 滚动 */
}
.virtual-scroll-viewport {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overflow-anchor: none;
  scrollbar-width: none; /* Firefox 隐藏原生 */
  -ms-overflow-style: none; /* IE10+ */
}
.virtual-scroll-viewport::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none; /* WebKit 隐藏原生 */
}

.virtual-scroll-content {
  position: relative;
  width: 100%;
}

.virtual-scroll-item {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  box-sizing: border-box;
  padding-bottom: var(--virtual-scroll-gap, 0px);
  // 不加 will-change: transform——透明合成层强制灰度抗锯齿，dpr=1 下小字号文字发虚
  // （见 docs/web/pet/agent-integration.md「VirtualScroll 定位约束」；滚动时浏览器自动临时提升合成层）
}

/* 自定义滚动条层：外层 flex 子（不随 viewport 滚动），自身作 track/thumb 定位上下文 */
.vs-scrollbar {
  position: relative;
  flex-shrink: 0;
  width: 12px;
  pointer-events: none; /* 容器透传，子元素各自接收 */
}
.vs-track {
  position: absolute;
  inset: 0;
  pointer-events: auto; /* 轨道本体可点（跳比例） */
}
.vs-thumb {
  position: absolute;
  left: 2px;
  right: 2px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 22%, transparent);
  cursor: grab;
  pointer-events: auto; /* thumb 可拖 */
  transition: background 0.15s ease;
}
.vs-thumb:hover {
  background: color-mix(in srgb, var(--ink) 38%, transparent);
}
.vs-thumb.is-dragging {
  background: color-mix(in srgb, var(--ink) 50%, transparent);
  cursor: grabbing;
  transition: none; /* 拖拽中禁用过渡避免滞后 */
}
@media (pointer: coarse) {
  .vs-scrollbar {
    width: 16px; /* 触屏 thumb 加宽 */
  }
}
</style>
