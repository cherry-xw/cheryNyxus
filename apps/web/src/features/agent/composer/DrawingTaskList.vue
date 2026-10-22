<script setup lang="ts">
import type { DrawingTask, DrawingCandidate } from '@chery/protocol'
import MessageParts from '../chat/MessageParts.vue'
import FileOperationSummary from '../chat/FileOperationSummary.vue'
defineProps<{ tasks: DrawingTask[]; editable?: boolean; disabled?: boolean; selectedId?: string }>()
defineEmits<{ select: [DrawingTask, DrawingCandidate, Event]; finalize: [DrawingTask, DrawingCandidate] }>()
</script>
<template>
  <section v-for="(task, taskIndex) in tasks" :key="task.taskId" class="drawing-task" :aria-label="`绘图任务 ${taskIndex + 1}`">
    <p class="heading">绘图任务 {{ taskIndex + 1 }} · {{ task.finalCandidateId ? '已有用户定稿' : '尚未定稿' }}</p>
    <section v-for="(round, roundIndex) in task.rounds" :key="round.roundId">
      <p class="heading">第 {{ roundIndex + 1 }} 轮 · {{ round.imageModel || '接口默认型号' }} · {{ round.intent.operation }}</p>
      <p>{{ round.feedback }}</p>
      <FileOperationSummary v-if="round.operation" :operations="[round.operation]" />
      <p v-else>等待模型理解、确认或调用绘图服务；尚未生成候选。</p>
      <details><summary>本轮固定参数与参考</summary>
        <pre>{{ JSON.stringify({ serviceId: round.intent.serviceId, count: round.imageCount, params: round.intent.params }, null, 2) }}</pre>
        <MessageParts v-if="round.inputAssets.length" :chat-id="task.chatId" :parts="round.inputAssets.map((ref, index) => ({ ...ref, partId: `${round.roundId}:input:${index}`, type: 'asset' as const, kind: 'image' as const, variant: 'original' as const, usage: 'content' as const }))" />
      </details>
      <p v-if="round.candidates.length && round.operation && ['succeeded', 'partial', 'failed', 'cancelled', 'result_unknown'].includes(round.operation.executionStatus) && round.operation.deliveryStatus !== 'saving'">本轮已结束，等待你选择或提交反馈。</p>
      <article v-for="(candidate, index) in round.candidates" :key="candidate.candidateId" class="candidate">
        <p class="heading">候选 {{ index + 1 }} {{ task.finalCandidateId === candidate.candidateId ? '· 用户定稿' : '' }}</p>
        <MessageParts :chat-id="task.chatId" :parts="[{ partId: candidate.candidateId, type: 'asset', kind: 'image', assetId: candidate.assetId, assetVersionId: candidate.assetVersionId, variant: 'original', usage: 'content' }]" />
        <template v-if="editable">
          <button type="button" :disabled="disabled" :aria-pressed="selectedId === candidate.candidateId" @click="$emit('select', task, candidate, $event)">以此图继续修改（不生成）</button>
          <button type="button" :disabled="disabled || task.finalCandidateId === candidate.candidateId" @click="$emit('finalize', task, candidate)">定稿（不生成）</button>
        </template>
      </article>
    </section>
  </section>
</template>
<style scoped>
.drawing-task { display:flex; flex-direction:column; gap:10px; min-width:0; } .drawing-task,.candidate { border-top:1px solid var(--border); padding-top:10px; margin-top:10px; } p { margin:0; overflow-wrap:anywhere; } .heading { font-weight:600; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; } button { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-strong); padding:7px; cursor:pointer; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
