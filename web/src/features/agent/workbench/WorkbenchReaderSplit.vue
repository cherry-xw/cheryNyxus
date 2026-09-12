<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
defineProps<{ open: boolean }>()
const frame = ref<HTMLElement>()
const available = ref(1000)
const width = ref(560)
const maximum = computed(() => Math.max(420, available.value - 330))
const actual = computed(() => Math.min(maximum.value, Math.max(420, width.value)))
let observer: ResizeObserver | undefined
let start: { x: number; width: number } | undefined
function down(event: PointerEvent): void {
  if (event.button !== 0) return
  start = { x: event.clientX, width: actual.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}
function move(event: PointerEvent): void {
  if (start)
    width.value = Math.min(maximum.value, Math.max(420, start.width + start.x - event.clientX))
}
function key(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  width.value =
    event.key === 'Home'
      ? 420
      : event.key === 'End'
        ? maximum.value
        : Math.min(
            maximum.value,
            Math.max(420, actual.value + (event.key === 'ArrowLeft' ? 32 : -32)),
          )
}
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) available.value = entry.contentRect.width
  })
  if (frame.value) observer.observe(frame.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <div
    ref="frame"
    class="workbench-reader-split"
    :class="{ 'has-reader': open, 'is-narrow': available < 750 }"
    :style="{ '--reader-width': `${actual}px` }"
  >
    <slot />
    <div
      v-if="open"
      class="reader-divider"
      role="separator"
      tabindex="0"
      aria-label="调整内容卡片宽度"
      aria-orientation="vertical"
      :aria-valuemin="420"
      :aria-valuemax="maximum"
      :aria-valuenow="actual"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="start = undefined"
      @pointercancel="start = undefined"
      @lostpointercapture="start = undefined"
      @keydown="key"
    />
    <slot v-if="open" name="reader" />
  </div>
</template>
<style scoped lang="less">
.workbench-reader-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.workbench-reader-split.has-reader {
  grid-template-columns: minmax(0, 1fr) 10px var(--reader-width);
}
.workbench-reader-split.has-reader.is-narrow {
  grid-template-columns: minmax(0, 1fr);
}
.is-narrow .reader-divider {
  display: none;
}
.is-narrow :slotted(.workbench-content-reader) {
  position: absolute;
  inset: 0;
  width: 100%;
  z-index: var(--nx-z-node-overlay);
}
.reader-divider {
  cursor: col-resize;
  touch-action: none;
  background: var(--panel);
  border-inline: 1px solid var(--border);
}
.reader-divider:is(:hover, :focus-visible) {
  background: color-mix(in srgb, var(--accent) 25%, var(--panel));
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
@media (max-width: 960px) {
  .workbench-reader-split.has-reader {
    grid-template-columns: minmax(0, 1fr);
  }
  .reader-divider {
    display: none;
  }
}
</style>
