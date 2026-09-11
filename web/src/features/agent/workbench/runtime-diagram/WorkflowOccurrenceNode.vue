<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import {
  Check,
  Close,
  Clock,
  Loading,
  QuestionFilled,
  Remove,
  Warning,
} from '@element-plus/icons-vue'
import type { WorkflowGraphNodeData } from './graphModel'

type OccurrenceData = Extract<WorkflowGraphNodeData, { kind: 'occurrence' }>
const props = defineProps<NodeProps<OccurrenceData>>()
const icon = computed(() => {
  const status = props.data.occurrence.status
  if (status === 'running') return Loading
  if (status === 'waiting') return Clock
  if (status === 'succeeded') return Check
  if (status === 'failed' || status === 'rejected') return Warning
  if (status === 'cancelled') return Close
  if (status === 'interrupted') return Remove
  return QuestionFilled
})
</script>

<template>
  <div class="workflow-node-root">
    <Handle type="target" :position="Position.Left" />
    <button
      type="button"
      class="workflow-occurrence-node nodrag nopan"
      :class="[`state-${data.occurrence.status}`, { 'is-live': data.live }]"
      :aria-label="`${data.occurrence.label}，${data.statusText}`"
      :data-workflow-occurrence-id="data.occurrence.occurrenceId"
      :data-workflow-source-header-id="data.sourceHeaderId"
      :data-workflow-step-kind="data.occurrence.kind"
      :data-workflow-status="data.occurrence.status"
    >
      <div class="workflow-node-heading">
        <component
          :is="icon"
          class="workflow-node-status-icon"
          data-workflow-state-icon
          aria-hidden="true"
        />
        <strong>{{ data.occurrence.label }}</strong>
      </div>
      <div class="workflow-node-meta">
        <span>{{ data.statusText }}</span>
        <span v-if="data.occurrence.attempt">尝试 {{ data.occurrence.attempt }}</span>
        <span v-else-if="data.occurrence.iteration">第 {{ data.occurrence.iteration }} 轮</span>
      </div>
      <small v-if="data.occurrence.orderQuality === 'reconstructed'">旧记录 · 顺序为重建</small>
    </button>
    <Handle type="source" :position="Position.Right" />
  </div>
</template>
