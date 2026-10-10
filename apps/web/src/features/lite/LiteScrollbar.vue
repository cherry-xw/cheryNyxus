<script setup lang="ts">
import { onBeforeUnmount, onMounted, onUpdated, reactive, ref } from 'vue'

/**
 * LiteScrollbar：自绘滚动条（需求：不使用普通滚动条，专门绘制自定义滚动条，参考「中轨迹」）。
 * 包裹任意内容，隐藏原生滚动条，用可拖拽 thumb 操作滚动。axis=x 横向、axis=y 纵向。
 * 通过默认插槽的 width/height 槽 prop 暴露视口尺寸，供父级计算自适应内容宽度。
 */
const props = defineProps<{ axis: 'x' | 'y' }>()

const viewportRef = ref<HTMLElement | null>(null)
const trackRef = ref<HTMLElement | null>(null)
const thumbRef = ref<HTMLElement | null>(null)

const viewportSize = reactive({ width: 0, height: 0 })
const thumbSize = ref(0)
const thumbOffset = ref(0)
const dragging = ref(false)

const isX = () => props.axis === 'x'
const axisKey = () => (isX() ? 'x' : 'y')

function measureViewport(): void {
  const vp = viewportRef.value
  if (!vp) return
  viewportSize.width = vp.clientWidth
  viewportSize.height = vp.clientHeight
  updateThumb()
}

function updateThumb(): void {
  const vp = viewportRef.value
  const track = trackRef.value
  if (!vp || !track) return
  const x = isX()
  const client = x ? vp.clientWidth : vp.clientHeight
  const content = x ? vp.scrollWidth : vp.scrollHeight
  const scroll = x ? vp.scrollLeft : vp.scrollTop
  const trackLen = x ? track.clientWidth : track.clientHeight
  if (content <= client + 1) {
    thumbSize.value = 0
    thumbOffset.value = 0
    return
  }
  const size = Math.max(28, trackLen * (client / content))
  const maxScroll = content - client
  const maxTravel = trackLen - size
  thumbSize.value = size
  thumbOffset.value = maxScroll > 0 ? (scroll / maxScroll) * maxTravel : 0
}

let dragState: { pointer: number; scroll: number } | null = null

function onThumbPointerDown(event: PointerEvent): void {
  event.preventDefault()
  const vp = viewportRef.value
  if (!vp) return
  const x = isX()
  dragState = {
    pointer: x ? event.clientX : event.clientY,
    scroll: x ? vp.scrollLeft : vp.scrollTop,
  }
  dragging.value = true
  thumbRef.value?.setPointerCapture(event.pointerId)
}

function onThumbPointerMove(event: PointerEvent): void {
  if (!dragState) return
  const vp = viewportRef.value
  const track = trackRef.value
  if (!vp || !track) return
  const x = isX()
  const pointer = x ? event.clientX : event.clientY
  const delta = pointer - dragState.pointer
  const client = x ? vp.clientWidth : vp.clientHeight
  const content = x ? vp.scrollWidth : vp.scrollHeight
  const trackLen = x ? track.clientWidth : track.clientHeight
  const maxScroll = Math.max(0, content - client)
  const maxTravel = Math.max(1, trackLen - thumbSize.value)
  const next = dragState.scroll + (maxScroll / maxTravel) * delta
  if (x) vp.scrollLeft = Math.max(0, Math.min(maxScroll, next))
  else vp.scrollTop = Math.max(0, Math.min(maxScroll, next))
}

function onThumbPointerUp(): void {
  dragState = null
  dragging.value = false
  updateThumb()
}

function onWheel(event: WheelEvent): void {
  // 横向轨迹：纵向滚轮也平移横向滚动，贴近「浏览器控制台请求时间线」的交互。
  const vp = viewportRef.value
  if (!vp || !isX()) return
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault()
    vp.scrollLeft += event.deltaY
  }
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  measureViewport()
  resizeObserver = new ResizeObserver(() => {
    measureViewport()
  })
  if (viewportRef.value) resizeObserver.observe(viewportRef.value)
})

// 内容变化（节点/轨迹增长）时同步 thumb，避免只靠 scroll/resize 时机漏更。
onUpdated(updateThumb)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <div
    class="lite-scrollbar"
    :class="[`is-${axisKey()}`, { 'has-thumb': thumbSize > 0, 'is-dragging': dragging }]"
  >
    <div ref="viewportRef" class="lite-scrollbar-viewport" @scroll="updateThumb" @wheel="onWheel">
      <slot :width="viewportSize.width" :height="viewportSize.height" />
    </div>
    <div ref="trackRef" class="lite-scrollbar-track">
      <button
        v-show="thumbSize > 0"
        ref="thumbRef"
        type="button"
        class="lite-scrollbar-thumb"
        :style="{
          [isX() ? 'width' : 'height']: thumbSize + 'px',
          transform: `translate${isX() ? 'X' : 'Y'}(${thumbOffset}px)`,
        }"
        aria-label="拖动滚动"
        tabindex="-1"
        @pointerdown="onThumbPointerDown"
        @pointermove="onThumbPointerMove"
        @pointerup="onThumbPointerUp"
        @pointercancel="onThumbPointerUp"
      />
    </div>
  </div>
</template>

<style scoped>
.lite-scrollbar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.lite-scrollbar.is-x {
  flex-direction: column;
}
.lite-scrollbar.is-y {
  flex-direction: row;
}
.lite-scrollbar-viewport {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
}
.lite-scrollbar-viewport::-webkit-scrollbar {
  display: none;
}
/* t13：超细滚动条 + 自动隐藏（仅 hover / 拖动 / 有溢出时显示轨道）。 */
.lite-scrollbar-track {
  position: relative;
  flex: none;
  border-radius: 0;
  background: var(--lite-track-bg, color-mix(in srgb, var(--el-border-color) 35%, transparent));
  opacity: 0;
  transition: opacity 140ms ease;
}
.lite-scrollbar.has-thumb:hover .lite-scrollbar-track,
.lite-scrollbar.is-dragging .lite-scrollbar-track {
  opacity: 1;
}
.lite-scrollbar.is-x .lite-scrollbar-track {
  height: 4px;
  margin-top: 3px;
}
.lite-scrollbar.is-y .lite-scrollbar-track {
  width: 4px;
  margin-left: 3px;
}
.lite-scrollbar-thumb {
  position: absolute;
  left: 0;
  top: 0;
  border: none;
  border-radius: 0;
  background: var(
    --lite-thumb-bg,
    color-mix(in srgb, var(--el-text-color-secondary) 60%, transparent)
  );
  cursor: grab;
  padding: 0;
  opacity: 0.8;
  transition:
    background-color 120ms ease,
    opacity 140ms ease;
}
.lite-scrollbar.is-x .lite-scrollbar-thumb {
  height: 4px;
}
.lite-scrollbar.is-y .lite-scrollbar-thumb {
  width: 4px;
}
.lite-scrollbar-thumb:hover {
  background: var(--el-color-primary);
}
.lite-scrollbar-thumb:active {
  cursor: grabbing;
  background: var(--el-color-primary);
}
</style>
