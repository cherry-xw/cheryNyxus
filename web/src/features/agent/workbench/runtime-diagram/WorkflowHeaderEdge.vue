<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@vue-flow/core'
import type { WorkflowGraphEdge } from './graphModel'
const props = defineProps<EdgeProps<NonNullable<WorkflowGraphEdge['data']>>>()
const points = computed(() => props.data?.points ?? [])
const path = computed(() =>
  points.value.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '),
)
const edgeColor = computed(() => {
  const status = props.data?.targetStatus
  if (status === 'waiting') return 'var(--warning)'
  if (status === 'succeeded') return 'var(--success)'
  if (status === 'failed' || status === 'rejected') return 'var(--danger)'
  if (status === 'cancelled' || status === 'interrupted') return 'var(--workflow-muted)'
  return props.data?.accent ?? 'var(--accent)'
})
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
    :style="data?.evidenced ? { stroke: edgeColor } : undefined"
  />
  <path
    v-if="data?.evidenced"
    :d="path"
    class="workflow-header-edge-signal"
    :data-workflow-edge-signal="id"
    :style="{ stroke: edgeColor }"
  />
  <circle
    v-if="data?.evidenced && points.length"
    r="5"
    class="workflow-header-edge-runner"
    :data-workflow-edge-runner="id"
    :transform="`translate(${points[0]!.x} ${points[0]!.y})`"
    :style="{ fill: edgeColor }"
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
.workflow-header-edge-signal {
  fill: none;
  stroke: var(--workflow-edge-accent, var(--accent));
  stroke-dasharray: 7 11;
  stroke-width: 2.4;
  opacity: 0.34;
  pointer-events: none;
}
.workflow-header-edge-runner {
  fill: var(--workflow-edge-accent, var(--accent));
  stroke: var(--panel);
  stroke-width: 2px;
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
}
</style>
