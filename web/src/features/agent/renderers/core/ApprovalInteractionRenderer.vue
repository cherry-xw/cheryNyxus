<script setup lang="ts">
/**
 * 对话模式中的待处理审批气泡。
 *
 * 审批状态仍由 interactions store 统一维护；这里仅把当前工具调用对应的
 * pending approval 投影成消息里的可操作气泡。处理完成后，组件会随交互记录
 * 进入终态并回到普通工具渲染。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { RendererProps } from '../types'
import type { InteractionRecord } from '@/application/backend/public'
import { useInteractionsStore } from '@/application/public'
import ApprovalSummary from '@/features/agent/cards/ApprovalSummary.vue'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import FileChangeDiff from '@/features/agent/cards/FileChangeDiff.vue'

const props = defineProps<RendererProps>()
const interactions = useInteractionsStore()

const interaction = computed<InteractionRecord | null>(() => {
  if (!props.call.id) return null
  return (
    interactions.pending.find(
      (item) => item.kind === 'approval' && item.interactionId === props.call.id,
    ) ?? null
  )
})
const deciding = ref<'accept' | 'reject' | null>(null)
const now = ref(interactions.calibratedNow())
let timer: ReturnType<typeof setInterval> | undefined
if (props.call.id) {
  timer = setInterval(() => {
    now.value = interactions.calibratedNow()
  }, 250)
}
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const args = computed(() => interaction.value?.payload.arguments)
const senseName = computed(() => {
  const value = interaction.value?.payload.senseName
  return typeof value === 'string' ? value : props.call.name
})
const remaining = computed(() => {
  const deadline = interaction.value?.deadlineAt
  if (typeof deadline !== 'number') return ''
  const ms = deadline - now.value
  if (ms <= 0) return '已超时'
  return `${Math.ceil(ms / 1000)}s`
})
const expired = computed(() => remaining.value === '已超时')
const errorMessage = computed(() => {
  const id = interaction.value?.interactionId
  return id ? interactions.errorsById[id]?.message : undefined
})

async function decide(action: 'accept' | 'reject'): Promise<void> {
  const item = interaction.value
  if (!item || deciding.value || expired.value) return
  deciding.value = action
  try {
    await interactions.decide(item, action)
  } catch {
    // 错误已按 interactionId 写入 store，气泡保留并允许重试。
  } finally {
    deciding.value = null
  }
}
</script>

<template>
  <section v-if="interaction" class="approval-interaction-bubble" aria-label="待处理审批">
    <header class="approval-interaction-head">
      <span class="approval-interaction-label">需要确认</span>
      <span
        v-if="remaining"
        class="approval-interaction-countdown"
        :class="{ 'is-expired': expired }"
      >
        {{ remaining }}
      </span>
    </header>
    <ApprovalSummary :sense-name="senseName" :args="args" />
    <details class="approval-interaction-details">
      <summary>完整操作参数</summary>
      <ParsedArgs :args="args" title="完整操作参数" embedded />
      <FileChangeDiff :args="args" embedded />
    </details>
    <p v-if="errorMessage" class="approval-interaction-error" role="alert">{{ errorMessage }}</p>
    <footer class="approval-interaction-actions">
      <button
        type="button"
        class="approval-interaction-btn is-reject"
        :disabled="!!deciding || expired"
        @click="decide('reject')"
      >
        拒绝
      </button>
      <button
        type="button"
        class="approval-interaction-btn is-accept"
        :disabled="!!deciding || expired"
        @click="decide('accept')"
      >
        {{ deciding === 'accept' ? '处理中…' : '允许执行' }}
      </button>
    </footer>
  </section>
</template>

<style scoped lang="less">
.approval-interaction-bubble {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(460px, 100%);
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warning) 55%, var(--border));
  border-radius: 10px; /* 对话模式圆角：与消息气泡 .bubble 一致 */
  background: color-mix(in srgb, var(--warning) 8%, var(--surface));
}
.approval-interaction-head,
.approval-interaction-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.approval-interaction-label {
  color: var(--warning);
  font-size: 14px;
  font-weight: 400;
}
.approval-interaction-countdown {
  margin-left: auto;
  color: var(--warning);
  font-family: var(--font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.approval-interaction-countdown.is-expired,
.approval-interaction-error {
  color: var(--danger);
}
.approval-interaction-details {
  border-top: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
}
.approval-interaction-details > summary {
  padding: 6px 0;
  color: var(--ink);
  cursor: pointer;
  font-size: 13px;
}
.approval-interaction-details :deep(.args-body) {
  padding-left: 0;
}
.approval-interaction-error {
  margin: 0;
  font-size: 13px;
}
.approval-interaction-btn {
  flex: 1;
  min-height: 30px;
  border: 1px solid var(--border);
  border-radius: 8px; /* 对话模式圆角：与发送钮/输入框一致 */
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  font: inherit;
}
.approval-interaction-btn.is-accept {
  border-color: var(--success);
  background: var(--success);
  color: var(--accent-ink);
}
.approval-interaction-btn.is-reject {
  border-color: var(--danger);
  color: var(--danger);
}
.approval-interaction-btn:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
