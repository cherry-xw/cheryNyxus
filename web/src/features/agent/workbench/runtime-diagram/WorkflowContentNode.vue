<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import {
  Back,
  Box,
  ChatDotRound,
  Collection,
  Monitor,
  Promotion,
  Tools,
  User,
} from '@element-plus/icons-vue'
import type { WorkflowGraphNodeData } from './graphModel'

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
    data-workflow-highlight-target
  >
    <Handle id="result-in" type="target" :position="Position.Left" />
    <button
      type="button"
      class="workflow-content-node nodrag nopan"
      :aria-label="data.presentation.ariaLabel"
      :title="data.preview"
      @click.stop="emit('select', props.data)"
    >
      <span class="workflow-result-glyph" aria-hidden="true">
        <User v-if="data.presentation.visualKind === 'input'" />
        <ChatDotRound v-else-if="data.presentation.visualKind === 'message'" />
        <Tools v-else-if="data.presentation.visualKind === 'tool'" />
        <Promotion v-else-if="data.presentation.visualKind === 'branch'" />
        <Back v-else-if="data.presentation.visualKind === 'return'" />
        <Collection v-else-if="data.presentation.visualKind === 'group'" />
        <Monitor v-else-if="data.presentation.visualKind === 'system'" />
        <Box v-else />
        <span v-if="data.presentation.toolCount > 1" class="workflow-result-count">
          {{ data.presentation.toolCount }}
        </span>
      </span>
      <span class="workflow-result-copy">
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
