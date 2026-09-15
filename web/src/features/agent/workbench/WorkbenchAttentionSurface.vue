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

/** 纸牌堆叠决策窗口：标题栏 ← 题目 n/N → 切换当前批次卡内的题目
 * （批次切换走左下角卡片漏边点击；关闭改由右侧铃铛入口切换）。 */
const browserRef = ref<InstanceType<typeof WorkspaceSessionBrowser> | null>(null)
const pager = ref({ index: 0, total: 0 })
const pagerIndex = computed(() => pager.value.index)
const pagerTotal = computed(() => pager.value.total)
function onPager(value: { index: number; total: number }): void {
  pager.value = value
}
function stepPager(delta: number): void {
  browserRef.value?.step(delta)
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
        <strong aria-live="polite">{{ others ? '其他流程' : '等待审批与回答' }} · {{ count }} 项</strong>
        <small>{{ others ? '其他流程需要你的确认或回答' : '待处理审批与提问' }}</small>
      </span>
      <div
        v-if="pagerTotal > 0"
        class="attention-pager"
        role="group"
        aria-label="切换批次内题目"
      >
        <button
          type="button"
          aria-label="上一题"
          :disabled="pagerTotal <= 1"
          @click="stepPager(-1)"
        >
          ←
        </button>
        <span class="attention-pager-index" aria-live="polite"
          >题目 {{ pagerIndex }}/{{ pagerTotal }}</span
        >
        <button
          type="button"
          aria-label="下一题"
          :disabled="pagerTotal <= 1"
          @click="stepPager(1)"
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
      @pager="onPager"
      @tree="forwardTree"
    />
  </div>
</template>

<style scoped lang="less" src="./WorkbenchAttentionSurface.styles.less"></style>
