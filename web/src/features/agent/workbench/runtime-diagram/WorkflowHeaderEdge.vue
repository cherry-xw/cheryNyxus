<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@vue-flow/core'
import type { WorkflowGraphEdge } from './graphModel'
const props = defineProps<EdgeProps<NonNullable<WorkflowGraphEdge['data']>>>()
const points = computed(() => props.data?.points ?? [])
const path = computed(
  () =>
    props.data?.renderPath ??
    points.value.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '),
)
const edgeColor = computed(() => 'var(--accent)')
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
  <g :data-workflow-layout-edge="id">
    <BaseEdge
      :id="id"
      :path="path"
      :marker-end="markerEnd"
      :interaction-width="18"
      :data-workflow-path="id"
      :style="{
        stroke: data?.evidenced ? edgeColor : 'var(--workflow-edge-idle)',
        strokeWidth: data?.evidenced ? 2.5 : 1,
        strokeOpacity: data?.evidenced ? (data.targetStatus === 'running' ? 1 : 0.85) : 1,
      }"
    />
    <path
      v-if="data?.evidenced"
      :d="path"
      pathLength="100"
      class="workflow-header-edge-signal"
      :data-workflow-edge-signal="id"
      :style="{ stroke: edgeColor }"
    />
    <path
      v-if="data?.evidenced"
      :d="path"
      pathLength="100"
      class="workflow-header-edge-signal"
      :data-workflow-edge-loop="id"
      :style="{ stroke: edgeColor, strokeWidth: data.targetStatus === 'running' ? 5 : 4 }"
    />
    <circle
      v-if="data?.evidenced && points.length"
      r="5"
      class="workflow-header-edge-runner"
      :data-workflow-edge-runner="id"
      :transform="`translate(${points[0]!.x} ${points[0]!.y})`"
      :style="{ fill: edgeColor }"
    />
    <circle
      v-if="data?.junction"
      :cx="data.junction.x"
      :cy="data.junction.y"
      r="3"
      fill="var(--workflow-edge-idle)"
    />
    <line
      v-if="data?.labelAnchor && data?.labelPoint"
      :x1="data.labelAnchor.x"
      :y1="data.labelAnchor.y"
      :x2="data.labelPoint.x"
      :y2="data.labelPoint.y"
      stroke="var(--workflow-edge-idle)"
      stroke-width="1"
    />
    <EdgeLabelRenderer v-if="data?.relationLabel && data?.labelPoint">
      <span
        class="workflow-header-edge-label"
        :style="{
          transform: `translate(-50%, -50%) translate(${labelPosition.x}px, ${labelPosition.y}px)`,
        }"
        >{{ data.relationLabel }}</span
      >
    </EdgeLabelRenderer>
  </g>
</template>
<style scoped lang="less">
.workflow-header-edge-label {
  position: absolute;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  padding: 2px 6px;
  font-size: 14px;
  font-weight: 400;
  line-height: 18px;
  white-space: nowrap;
  pointer-events: none;
}
.workflow-header-edge-signal {
  fill: none;
  stroke: var(--workflow-edge-accent, var(--accent));
  stroke-dasharray: 12 88;
  stroke-width: 2.4;
  opacity: 0;
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
