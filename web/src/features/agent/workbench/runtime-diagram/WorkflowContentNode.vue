<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PopoverInstance } from 'element-plus'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import type { IconInput } from 'morphicons/vue'
import { Activity } from 'lucide'
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

// 图标状态机（工作台示例，基于 Morphicons 变形组件）：
//  A = 类型图标（等待 / 终态兜底）→ B = 运行图标（运行中主 icon 平滑变形为 Activity 脉冲线）
//  → C = 终态徽标（运行结束才出现：✓ / ✗ / 暂停，压在右上角边框线上）
const isRunning = computed(() => props.data.presentation.statusTone === 'running')
const mainIcon = computed<IconInput>(() => (isRunning.value ? Activity : props.data.visual.icon))
const badgeIcon = computed<IconInput | undefined>(() =>
  isRunning.value ? undefined : statusIcon(props.data.presentation.statusTone),
)
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
              :icon="mainIcon"
              :status-icon="badgeIcon"
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
