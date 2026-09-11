<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import type { WorkflowGraphNodeData } from './graphModel'
import WorkflowMorphIcon from './WorkflowMorphIcon.vue'
import { statusIcon, visualStyle } from './workflowVisuals'

type ContentData = Extract<WorkflowGraphNodeData, { kind: 'content' }>
const props = defineProps<NodeProps<ContentData>>()
const emit = defineEmits<{ select: [data: ContentData] }>()
</script>

<template>
  <div
    class="workflow-node-root workflow-result-node-root"
    :class="[
      `visual-${data.presentation.visualKind}`,
      `status-${data.presentation.statusTone}`,
      { 'is-revoked': data.node.status === 'revoked' },
    ]"
    :style="visualStyle(data.visual)"
    data-workflow-highlight-target
    :data-workflow-content-id="id"
  >
    <Handle id="result-in" type="target" :position="Position.Left" />
    <button
      type="button"
      class="workflow-content-node nodrag nopan"
      :aria-label="data.presentation.ariaLabel"
      :title="data.preview"
      @click.stop="emit('select', props.data)"
    >
      <span class="workflow-result-glyph" :class="`skin-${data.visual.shape}`" aria-hidden="true">
        <WorkflowMorphIcon
          :icon="data.visual.icon"
          :status-icon="statusIcon(data.presentation.statusTone)"
          :size="25"
        />
        <span v-if="data.presentation.toolCount > 1" class="workflow-result-count">
          {{ data.presentation.toolCount }}
        </span>
      </span>
      <span class="workflow-result-copy" data-workflow-node-visual>
        <strong>{{ data.title }}</strong>
        <span class="workflow-result-status">
          <i aria-hidden="true" />
          {{ data.presentation.statusText }}
        </span>
        <small>{{ data.presentation.detail }}</small>
      </span>
    </button>
    <Handle id="result-out" type="source" :position="Position.Right" />
  </div>
</template>
