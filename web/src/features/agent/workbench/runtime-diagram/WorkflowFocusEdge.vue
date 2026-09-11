<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, type EdgeProps } from '@vue-flow/core'
import type { WorkflowGraphEdge } from './graphModel'

const props = defineProps<EdgeProps<NonNullable<WorkflowGraphEdge['data']>>>()
const points = computed(() => props.data?.points ?? [])
const path = computed(() =>
  points.value.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '),
)
</script>

<template>
  <BaseEdge :id="id" :path="path" :interaction-width="0" class="workflow-focus-edge" />
  <circle
    v-if="points.length"
    r="6"
    class="workflow-focus-edge-runner"
    :data-workflow-focus-runner="id"
    :transform="`translate(${points[0]!.x} ${points[0]!.y})`"
  />
</template>

<style scoped lang="less">
:deep(.workflow-focus-edge) {
  stroke: color-mix(in srgb, var(--accent) 72%, transparent);
  stroke-dasharray: 4 8;
  stroke-width: 2px;
  pointer-events: none;
}
.workflow-focus-edge-runner {
  fill: var(--accent);
  stroke: var(--panel);
  stroke-width: 2px;
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
}
</style>
