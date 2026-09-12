<script setup lang="ts">
import { ref } from 'vue'
import type { PopoverInstance } from 'element-plus'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import type { WorkflowGraphNodeData } from './graphModel'
import WorkflowMorphIcon from './WorkflowMorphIcon.vue'
import WorkflowContentPreview from './WorkflowContentPreview.vue'
import { statusIcon, visualStyle } from './workflowVisuals'

type ContentData = Extract<WorkflowGraphNodeData, { kind: 'content' }>
const props = defineProps<NodeProps<ContentData>>()
const emit = defineEmits<{ select: [data: ContentData] }>()
const previewOpen = ref(false)
const popover = ref<PopoverInstance>()
function closePreview(): void {
  popover.value?.hide()
  previewOpen.value = false
}
function selectContent(): void {
  closePreview()
  emit('select', props.data)
}
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
    <el-popover
      ref="popover"
      trigger="hover"
      placement="top"
      :show-after="220"
      :hide-after="180"
      :width="560"
      :popper-style="{ maxWidth: 'calc(100vw - 32px)', borderRadius: '0' }"
      @show="previewOpen = true"
      @hide="previewOpen = false"
    >
      <template #reference
        ><button
          type="button"
          class="workflow-content-node nodrag nopan"
          :aria-label="data.presentation.ariaLabel"
          @click.stop="selectContent"
        >
          <span
            class="workflow-result-glyph"
            :class="`skin-${data.visual.shape}`"
            aria-hidden="true"
          >
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
        </button></template
      >
      <WorkflowContentPreview
        v-if="previewOpen"
        :data="data"
        @select="selectContent"
        @close="closePreview"
      />
    </el-popover>
    <Handle id="result-out" type="source" :position="Position.Right" />
  </div>
</template>
