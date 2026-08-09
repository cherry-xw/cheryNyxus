<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ApprovalCard from '@/features/agent/cards/ApprovalCard.vue'
import QuestionCard from '@/features/agent/cards/QuestionCard.vue'
import { SenseCallRenderer } from '@/features/agent/renderers'
import type { ApprovalState } from '@/stores/agents'
import type { ExecutionEdge, ExecutionNode } from '../graph/executionGraph'
import type { NodePopoverQuestion } from '../graph/nodePopoverModel'
import {
  actorDetail,
  graphToolCallToSenseCall,
  selectedToolCall,
  toolBatchDetail,
  toolBatchUsesTabs,
} from '../graph/toolBatchDetails'
import { terminationDisplay } from '../graph/termination'

const RESULT_PREVIEW_LIMIT = 20_000
const props = defineProps<{
  node: ExecutionNode
  foldNode?: ExecutionNode
  relatedEdges: ExecutionEdge[]
  pinned: boolean
  maxHeight: number
  selectedCallId?: string
  chatId?: string
  approval?: ApprovalState
  question?: NodePopoverQuestion
}>()
const emit = defineEmits<{ close: []; selectCall: [callId: string] }>()
const batch = computed(() => toolBatchDetail(props.node))
const nodeTermination = computed(() =>
  props.node.sourceFact?.termination
    ? terminationDisplay(props.node.sourceFact.termination)
    : undefined,
)
const foldPosition = computed(() => {
  const members = props.foldNode?.fold?.members ?? []
  const index = members.findIndex(
    (member) =>
      member.displayNode.id === props.node.id ||
      member.nodes.some((node) => node.id === props.node.id),
  )
  return index >= 0 ? { index: index + 1, total: members.length } : undefined
})
const copyLabel = ref('复制')
const batchInfo = computed(() => {
  const current = props.question
  if (!current) return null
  return {
    batchId: current.batch.batchId,
    total: current.batch.questions.length,
    readyCount: current.batch.questions.filter((question) => question.localStatus === 'ready').length,
    currentIndex: current.currentIndex,
    isLast: current.currentIndex === current.batch.questions.length - 1,
  }
})

watch(
  () => batch.value?.calls.map((call) => call.callId),
  (ids) => {
    if (ids?.includes(props.selectedCallId ?? '')) return
    const fallback = selectedToolCall(batch.value?.calls ?? [], props.selectedCallId)
    if (fallback) emit('selectCall', fallback.callId)
  },
  { immediate: true },
)

const selectedCall = computed(() =>
  selectedToolCall(batch.value?.calls ?? [], props.selectedCallId),
)
const rendererCall = computed(() => {
  const call = selectedCall.value
  if (!call) return undefined
  const truncated =
    call.result && call.result.length > RESULT_PREVIEW_LIMIT
      ? `${call.result.slice(0, RESULT_PREVIEW_LIMIT)}\n\n…结果已截断，请使用复制获取完整内容。`
      : call.result
  return graphToolCallToSenseCall({
    ...call,
    ...(truncated === undefined ? {} : { result: truncated }),
  })
})
const resultTruncated = computed(
  () => (selectedCall.value?.result?.length ?? 0) > RESULT_PREVIEW_LIMIT,
)
const detailRows = computed(() => {
  const fact = props.node.sourceFact
  return [
    ['类型', fact?.kind ?? props.node.kind],
    ['来源', actorDetail(fact?.actor ?? props.node.actor)],
    ['目标', actorDetail(fact?.target ?? props.node.target)],
    ['来源会话', fact?.sourceChatId ?? props.node.sourceChatId],
    ['方向', fact?.direction ?? props.node.direction],
    ['状态', props.node.inputState ?? fact?.status ?? props.node.status],
    ...(fact?.kind === 'return'
      ? [
          [
            '因果路径',
            props.relatedEdges.find((edge) => edge.kind === 'return')?.from ??
              fact.causationId ??
              fact.sourceMessageId ??
              fact.id,
          ],
        ]
      : []),
    ...(fact?.kind === 'dispatch' && fact.target?.kind === 'agent'
      ? [['目标会话', fact.target.chatId]]
      : []),
  ]
})

async function copySelectedCall(): Promise<void> {
  const call = selectedCall.value
  if (!call) return
  const text = JSON.stringify(
    {
      callId: call.callId,
      index: call.index,
      name: call.name,
      status: call.status,
      arguments: call.arguments,
      result: call.result,
      childChatId: call.childChatId,
      targetChatId: call.targetChatId,
    },
    null,
    2,
  )
  try {
    await navigator.clipboard?.writeText(text)
    copyLabel.value = '已复制'
  } catch {
    copyLabel.value = '复制失败'
  }
  window.setTimeout(() => (copyLabel.value = '复制'), 1200)
}
</script>

<template>
  <aside
    class="node-popover"
    :class="{ 'is-pinned': pinned, 'is-actionable': approval || question }"
    :style="{ maxHeight: `${maxHeight}px` }"
    role="dialog"
    aria-label="节点详情"
  >
    <header class="popover-head">
      <div>
        <strong>{{
          foldPosition
            ? `Fold · ${foldPosition.index}/${foldPosition.total}`
            : batch?.spawn
              ? 'Spawn 工具批次'
              : batch
                ? '工具批次'
                : '节点详情'
        }}</strong>
        <small v-if="batch">{{ batch.batchId }} · {{ batch.status }}</small>
        <small v-else>{{ node.kind }} · {{ node.id }}</small>
      </div>
      <button
        v-if="pinned && !approval && !question"
        type="button"
        class="close-button"
        aria-label="关闭详情"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <section v-if="approval || question" class="node-action">
      <ApprovalCard
        v-if="approval && chatId"
        :approval="approval"
        :chat-id="chatId"
      />
      <QuestionCard
        v-else-if="question && chatId"
        :question="question.question"
        :chat-id="chatId"
        :batch-info="batchInfo"
      />
    </section>

    <template v-if="batch">
      <div
        v-if="toolBatchUsesTabs(batch.calls)"
        class="tool-tabs"
        role="tablist"
        aria-label="工具调用"
      >
        <button
          v-for="(call, callPosition) in batch.calls"
          :key="call.callId"
          type="button"
          role="tab"
          :aria-selected="call.callId === selectedCall?.callId"
          :class="{ active: call.callId === selectedCall?.callId }"
          @click="emit('selectCall', call.callId)"
        >
          {{ node.kind === 'fold' ? callPosition + 1 : call.index + 1 }} · {{ call.name }}
        </button>
      </div>
      <section v-if="selectedCall && rendererCall" class="tool-detail">
        <div class="tool-meta">
          <span>#{{ selectedCall.index + 1 }} · {{ selectedCall.status }}</span>
          <span v-if="foldPosition">batch: {{ selectedCall.batchId }}</span>
          <span v-if="selectedCall.childChatId">child: {{ selectedCall.childChatId }}</span>
          <button type="button" @click="copySelectedCall">{{ copyLabel }}</button>
        </div>
        <p v-if="resultTruncated" class="truncation-hint">
          结果较大，预览截断；复制仍包含完整结果。
        </p>
        <SenseCallRenderer :id="selectedCall.callId" :call="rendererCall" default-expanded />
      </section>
      <p v-else class="empty-detail">批次尚无工具调用详情。</p>
      <ul v-if="batch.terminations.length" class="termination-list" aria-label="终止尾注">
        <li
          v-for="termination in batch.terminations"
          :key="`${termination.batchId}:${termination.code}`"
        >
          {{ termination.batchId }} ·
          {{ terminationDisplay({ actor: 'system', code: termination.code, at: 0 }).label }}
        </li>
      </ul>
    </template>

    <dl v-else class="fact-detail">
      <template v-for="row in detailRows" :key="row[0]">
        <dt>{{ row[0] }}</dt>
        <dd>{{ row[1] }}</dd>
      </template>
      <dt v-if="node.content">内容</dt>
      <dd v-if="node.content" class="fact-content">{{ node.content }}</dd>
      <dt v-if="nodeTermination">终止</dt>
      <dd v-if="nodeTermination" class="termination-note" :class="`tone-${nodeTermination.tone}`">
        {{ nodeTermination.label }}
      </dd>
    </dl>
  </aside>
</template>

<style scoped lang="less">
.node-popover {
  width: 360px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #e8f8ff;
  border: 1px solid rgba(107, 207, 247, 0.5);
  border-radius: 12px;
  background: rgba(7, 19, 30, 0.96);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(14px);
  user-select: text;
  -webkit-user-select: text;
}
.node-popover.is-actionable {
  border-color: rgba(181, 255, 242, 0.82);
  box-shadow:
    0 0 0 1px rgba(181, 255, 242, 0.16),
    0 18px 42px rgba(0, 0, 0, 0.42);
}
.node-action {
  flex: 0 0 auto;
  padding: 9px;
  border-bottom: 1px solid rgba(107, 207, 247, 0.22);
}
.node-action :deep(.approval-card),
.node-action :deep(.question-card) {
  width: auto;
  max-width: none;
}
.node-popover.is-pinned {
  border-color: rgba(181, 255, 242, 0.72);
}
.popover-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 12px 8px;
}
.popover-head div {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.popover-head strong {
  font-size: 12px;
}
.popover-head small {
  overflow: hidden;
  color: rgba(202, 231, 244, 0.62);
  font:
    9px/1.3 ui-monospace,
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close-button,
.tool-meta button {
  border: 0;
  color: #dffaff;
  background: rgba(107, 207, 247, 0.12);
  cursor: pointer;
}
.close-button {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 18px;
  line-height: 20px;
}
.tool-tabs {
  display: flex;
  gap: 4px;
  padding: 0 10px 8px;
  overflow-x: auto;
  scrollbar-width: thin;
}
.tool-tabs button {
  flex: 0 0 auto;
  max-width: 170px;
  overflow: hidden;
  padding: 5px 8px;
  border: 1px solid rgba(107, 207, 247, 0.18);
  border-radius: 7px;
  color: rgba(221, 245, 255, 0.65);
  background: transparent;
  font:
    9px/1.2 ui-monospace,
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.tool-tabs button.active {
  color: #fff;
  border-color: #6bcff7;
  background: rgba(107, 207, 247, 0.14);
}
.tool-detail {
  min-height: 0;
  padding: 0 10px 10px;
  overflow: auto;
  overscroll-behavior: contain;
}
.tool-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: rgba(202, 231, 244, 0.7);
  font:
    9px/1.3 ui-monospace,
    monospace;
}
.tool-meta button {
  margin-left: auto;
  padding: 3px 7px;
  border-radius: 5px;
  font: inherit;
}
.truncation-hint {
  margin: 0 0 6px;
  color: #ffca73;
  font-size: 10px;
}
.empty-detail {
  margin: 0;
  padding: 12px;
  color: rgba(202, 231, 244, 0.6);
  font-size: 11px;
}
.termination-list {
  margin: 0 10px 10px;
  padding: 7px 8px 7px 24px;
  overflow: auto;
  color: #ffca73;
  border: 1px solid rgba(255, 202, 115, 0.22);
  border-radius: 7px;
  font:
    9px/1.4 ui-monospace,
    monospace;
}
.fact-detail {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 7px 10px;
  margin: 0;
  padding: 4px 12px 12px;
  overflow: auto;
  font-size: 11px;
}
.fact-detail dt {
  color: rgba(202, 231, 244, 0.55);
}
.fact-detail dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.fact-content {
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
}
:deep(.sense-box),
:deep(.spawn-box) {
  color: #dff4ff;
  border-color: rgba(107, 207, 247, 0.22);
  background: rgba(255, 255, 255, 0.06);
}
</style>
