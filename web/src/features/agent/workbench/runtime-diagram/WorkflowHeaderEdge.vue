<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@vue-flow/core'
import type { WorkflowGraphEdge } from './graphModel'
const props = defineProps<EdgeProps<NonNullable<WorkflowGraphEdge['data']>>>()
const points = computed(() => props.data?.points ?? [])
const path = computed(() =>
  points.value.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '),
)
const labelPosition = computed(() => {
  if (props.data?.labelPoint) return props.data.labelPoint
  const pairs = points.value.slice(1).map((end, index) => ({ start: points.value[index]!, end }))
  const segment = pairs.sort(
    (a, b) =>
      Math.abs(b.end.x - b.start.x) +
      Math.abs(b.end.y - b.start.y) -
      (Math.abs(a.end.x - a.start.x) + Math.abs(a.end.y - a.start.y)),
  )[0]
  return segment
    ? { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 }
    : { x: 0, y: 0 }
})
</script>
<template>
  <BaseEdge
    :id="id"
    :path="path"
    :marker-end="markerEnd"
    :interaction-width="0"
    :data-workflow-path="id"
  />
  <EdgeLabelRenderer v-if="data?.relationLabel">
    <span
      class="workflow-header-edge-label"
      :style="{
        transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
      }"
      >{{ data.relationLabel }}</span
    >
  </EdgeLabelRenderer>
</template>
<style scoped lang="less">
.workflow-header-edge-label {
  position: absolute;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  padding: 2px 6px;
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
  white-space: nowrap;
  pointer-events: none;
}
</style>
