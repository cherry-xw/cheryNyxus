<script setup lang="ts">
import { BellFilled } from '@element-plus/icons-vue'
import { WorkspaceSessionBrowser } from '@/features/agent/attention/public'

withDefaults(defineProps<{ presetId?: string; rootChatId?: string; count: number; others?: boolean; embedded?: boolean }>(), { embedded: false })
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
  <div class="workbench-attention-surface" :class="{ 'is-embedded': embedded }" role="region" aria-label="待处理审批与提问">
    <header class="workbench-attention-head">
      <span>
        <BellFilled aria-hidden="true" />
        <strong aria-live="polite">{{ others ? '其他流程' : '等待审批与回答' }} · {{ count }} 项</strong>
        <small>{{ others ? '其他流程需要你的确认或回答' : '待处理审批与提问' }}</small>
      </span>
      <button v-if="!embedded" type="button" aria-label="关闭审批与提问窗口" @click="emit('close')">关闭</button>
    </header>
    <WorkspaceSessionBrowser
      class="workbench-attention-browser"
      :exclude-root-chat-id="others ? rootChatId : undefined"
      :root-chat-id="others ? undefined : rootChatId"
      pending-only
      @tree="forwardTree"
    />
  </div>
</template>

<style scoped lang="less" src="./WorkbenchAttentionSurface.styles.less"></style>
