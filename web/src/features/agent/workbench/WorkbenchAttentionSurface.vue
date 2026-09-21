<script setup lang="ts">
import { computed, ref } from 'vue'
import { BellFilled } from '@element-plus/icons-vue'
import { WorkspaceSessionBrowser } from '@/features/agent/attention/public'

withDefaults(
  defineProps<{
    presetId?: string
    rootChatId?: string
    count: number
    others?: boolean
    embedded?: boolean
  }>(),
  { embedded: false },
)
const emit = defineEmits<{
  close: []
  tree: [rootChatId: string, sourceChatId?: string, interactionId?: string, anchorNodeId?: string]
}>()

/** 决策窗口：标题栏 ← 批次 n/N → 切换批次卡（卡内题目切换固定在底部操作栏左侧，与提交按钮同行）。 */
const browserRef = ref<InstanceType<typeof WorkspaceSessionBrowser> | null>(null)
const batchPager = ref({ index: 0, total: 0 })
const batchIndex = computed(() => batchPager.value.index)
const batchTotal = computed(() => batchPager.value.total)
function onBatchPager(value: { index: number; total: number }): void {
  batchPager.value = value
}
function stepBatch(delta: number): void {
  browserRef.value?.stepBatch(delta)
}

function forwardTree(
  rootChatId: string,
  sourceChatId?: string,
  interactionId?: string,
  anchorNodeId?: string,
): void {
  emit('tree', rootChatId, sourceChatId, interactionId, anchorNodeId)
}
</script>

<template>
  <div
    class="workbench-attention-surface"
    :class="{ 'is-embedded': embedded }"
    role="region"
    aria-label="待处理审批与提问"
  >
    <header class="workbench-attention-head">
      <span>
        <BellFilled aria-hidden="true" />
        <strong aria-live="polite"
          >{{ others ? '其他流程' : '等待审批与回答' }} · {{ count }} 项</strong
        >
      </span>
      <div v-if="batchTotal > 1" class="attention-pager" role="group" aria-label="切换批次">
        <button
          type="button"
          aria-label="上一批次"
          :disabled="batchTotal <= 1"
          @click="stepBatch(-1)"
        >
          ←
        </button>
        <span class="attention-pager-index" aria-live="polite"
          >批次 {{ batchIndex }}/{{ batchTotal }}</span
        >
        <button
          type="button"
          aria-label="下一批次"
          :disabled="batchTotal <= 1"
          @click="stepBatch(1)"
        >
          →
        </button>
      </div>
    </header>
    <WorkspaceSessionBrowser
      ref="browserRef"
      class="workbench-attention-browser"
      stepper
      :exclude-root-chat-id="others ? rootChatId : undefined"
      :root-chat-id="others ? undefined : rootChatId"
      pending-only
      @batch-pager="onBatchPager"
      @tree="forwardTree"
    />
  </div>
</template>

<style scoped lang="less" src="./WorkbenchAttentionSurface.styles.less"></style>
