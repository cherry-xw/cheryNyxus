<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ActiveTurnSnapshot } from '@/application/backend/public'
import type { WorkflowOverlayPlacement } from './useWorkflowNodePresentation'
import WorkflowLiveCrt from './WorkflowLiveCrt.vue'

const props = defineProps<{
  attention?: WorkflowOverlayPlacement
  crt?: WorkflowOverlayPlacement
  turn?: ActiveTurnSnapshot
}>()
const sharedAnchor = computed(() =>
  !!props.attention && props.attention.anchorId === props.crt?.anchorId,
)
const attentionElement = ref<HTMLElement>()
const attentionHeight = ref(0)
let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  resizeObserver = new ResizeObserver(([entry]) => {
    attentionHeight.value = entry?.contentRect.height ?? 0
  })
  if (attentionElement.value) resizeObserver.observe(attentionElement.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
const positionedCrtStyle = computed(() => {
  if (!props.crt || !sharedAnchor.value) return props.crt?.style
  return {
    ...props.crt.style,
    top: `${parseFloat(props.crt.style.top) + attentionHeight.value + 12}px`,
  }
})
</script>

<template>
  <div
    v-show="attention"
    ref="attentionElement"
    class="workflow-overlay-anchor workflow-attention-anchor nodrag nopan nowheel"
    :style="attention?.style"
    @pointerdown.stop @wheel.stop @keydown.stop
  ><slot name="attention" /></div>
  <div
    v-if="crt"
    class="workflow-overlay-anchor nodrag nopan nowheel"
    :class="{ 'is-measuring-stack': sharedAnchor && !attentionHeight }"
    :style="positionedCrtStyle"
    @pointerdown.stop @wheel.stop @keydown.stop
  ><WorkflowLiveCrt :turn="turn" /></div>
</template>

<style scoped lang="less">
.workflow-overlay-anchor {
  position: absolute;
  z-index: var(--nx-z-side-popover);
  display: grid;
  justify-items: center;
  pointer-events: none;
}
.is-measuring-stack { visibility: hidden; }
.workflow-overlay-anchor :deep(.workbench-attention-surface),
.workflow-overlay-anchor :deep(.workflow-live-crt) {
  pointer-events: auto;
}
.workflow-overlay-anchor :deep(.workbench-attention-surface) {
  position: relative;
  inset: auto;
}
</style>
