<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@vue-flow/core'
import type { WorkflowGraphEdge } from './graphModel'

type ResultEdgeData = NonNullable<WorkflowGraphEdge['data']>
const props = defineProps<EdgeProps<ResultEdgeData>>()

const path = computed(() =>
  getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    borderRadius: 0,
    offset: 28,
  }),
)
</script>

<template>
  <BaseEdge
    :id="id"
    :path="path[0]"
    :marker-end="markerEnd"
    :style="style"
    :interaction-width="18"
  />
  <EdgeLabelRenderer v-if="data?.relationLabel">
    <span
      class="workflow-result-edge-label nopan nodrag"
      :style="{
        transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)`,
      }"
    >
      {{ data.relationLabel }}
    </span>
  </EdgeLabelRenderer>
</template>

<style scoped lang="less">
.workflow-result-edge-label {
  position: absolute;
  z-index: 1;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--panel);
  padding: 1px 4px;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
  line-height: 18px;
  pointer-events: none;
}
</style>
