<script setup lang="ts">
import { BellFilled, Close } from '@element-plus/icons-vue'
import { WorkspaceSessionBrowser } from '@/features/agent/attention/public'

withDefaults(defineProps<{ presetId?: string; native?: boolean }>(), { native: false })
const emit = defineEmits<{
  close: []
  tree: [rootChatId: string, sourceChatId?: string, interactionId?: string, anchorNodeId?: string]
}>()

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
    role="dialog"
    aria-modal="false"
    aria-label="待处理审批与提问"
  >
    <header class="workbench-attention-head">
      <span>
        <BellFilled aria-hidden="true" />
        <strong>待处理审批与提问</strong>
        <small>这里的操作始终针对当前待处理请求，不受执行图所选历史内容影响。</small>
      </span>
      <button type="button" aria-label="关闭待处理面板" @click="emit('close')">
        <Close aria-hidden="true" />
      </button>
    </header>
    <WorkspaceSessionBrowser
      class="workbench-attention-browser"
      :preset-id="presetId"
      :native="native"
      @tree="forwardTree"
    />
  </div>
</template>

<style scoped lang="less" src="./WorkbenchAttentionSurface.styles.less"></style>
