<script setup lang="ts">
import { computed } from 'vue'
import type { InteractionRecord } from '@/application/backend/public'
import { useInteractionsStore } from '@/application/public'
import ApprovalSummary from '@/features/agent/cards/ApprovalSummary.vue'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import FileChangeDiff from '@/features/agent/cards/FileChangeDiff.vue'
import { countdownOf, kindLabel, payload, questionsOf, statusOf, timeOf, titleOf } from './interactionPresentation'
import InteractionQuestionFieldset from './InteractionQuestionFieldset.vue'

const props = withDefaults(
  defineProps<{
    item: InteractionRecord
    now: number
    pendingOnly?: boolean
    section?: 'pending' | 'activity'
    showFooter?: boolean
    /** 纸牌堆叠：整卡标题恒显（列表模式保持既有「pendingOnly 只显审批标题」逻辑）。 */
    titleAlways?: boolean
    /** 纸牌堆叠：只展示该下标的题目（undefined = 列表模式展示全部题目）。 */
    questionIndex?: number
  }>(),
  {
    pendingOnly: false,
    section: 'pending',
    showFooter: true,
    titleAlways: false,
    questionIndex: undefined,
  },
)
const emit = defineEmits<{
  tree: [rootChatId: string, sourceChatId?: string, interactionId?: string, anchorNodeId?: string]
  decide: [action: 'accept' | 'reject']
  answer: []
}>()
const interactions = useInteractionsStore()
const countdown = computed(() => countdownOf(props.item, props.now))
</script>

<template>
  <article class="interaction-card" :class="`is-${item.status}`">
    <header>
      <span class="kind" :class="item.kind === 'approval' ? 'is-approval' : 'is-question'">{{
        kindLabel(item)
      }}</span>
      <strong v-if="titleAlways || !pendingOnly || item.kind === 'approval'">{{
        titleOf(item)
      }}</strong>
      <small>
        {{ statusOf(item) }} · {{ timeOf(item.createdAt) }}
        <!-- 审批倒计时：后端 deadlineAt，归零变红提示超时。 -->
        <template v-if="countdown.total">
          <span v-if="countdown.expired" class="countdown is-expired">已超时</span>
          <span v-else class="countdown">剩余 {{ Math.ceil(countdown.remaining / 1000) }}s</span>
        </template>
      </small>
    </header>

    <template v-if="item.kind === 'approval'">
        <ApprovalSummary :sense-name="payload(item).senseName" :args="payload(item).arguments" />
        <ParsedArgs :args="payload(item).arguments" title="完整操作参数" />
        <FileChangeDiff :args="payload(item).arguments" />
      </template>
      <div v-else class="questions">
        <!-- 纸牌堆叠：只渲染当前题目；列表模式渲染该批全部题目（legend 编号始终按全批序号） -->
        <template v-for="(question, qi) in questionsOf(item)" :key="question.questionId">
          <InteractionQuestionFieldset
            v-if="questionIndex === undefined || qi === questionIndex"
            :item="item"
            :question="question"
            :question-index="qi"
            :total-questions="questionsOf(item).length"
            :disabled="item.status !== 'pending'"
          />
        </template>
      </div>
      <p v-if="interactions.errorsById[item.interactionId]" class="object-error" role="alert">
        {{ interactions.errorsById[item.interactionId]?.message }}
      </p>

    <footer v-if="showFooter">
      <button
        type="button"
        class="locate"
        @click="emit('tree', item.rootChatId, item.chatId, item.interactionId, item.anchorNodeId)"
      >
        在节点树中查看
      </button>
      <template v-if="section === 'pending' && item.kind === 'approval'">
        <button
          type="button"
          class="reject"
          :disabled="item.status === 'resolving'"
          @click="emit('decide', 'reject')"
        >
          拒绝
        </button>
        <button
          type="button"
          class="accept"
          :disabled="item.status === 'resolving'"
          @click="emit('decide', 'accept')"
        >
          {{ item.status === 'blocked' ? '重试并接受' : '接受' }}
        </button>
      </template>
      <button
        v-else-if="section === 'pending' && item.kind === 'question_batch'"
        type="button"
        class="accept"
        :disabled="item.status !== 'pending'"
        @click="emit('answer')"
      >
        提交回答
      </button>
    </footer>
  </article>
</template>

<style scoped lang="less">
.interaction-card {
  padding: 11px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 12px;
  background: var(--surface);
}
.interaction-card.is-blocked {
  border-color: #e59a35;
}
article header {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
article header strong {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 400;
}
article header small {
  flex: none;
  font-size: 12px;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
}
article header small .countdown {
  color: #1a7f52;
}
article header small .countdown.is-expired {
  color: #c02e47;
}
// kind 标签双色高对比（需确认=金 / 需回答=紫）：实色底 + 白字，深/浅主题下对比度恒定，
// native 与浮动窗全局统一（杜绝 color-mix 混主题色在深色下底色文字同色系看不清）
.kind {
  flex: none;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 400;
}
.kind.is-approval {
  background: #d88a26;
}
.kind.is-question {
  background: #7c3aed;
}
article footer {
  display: flex;
  align-items: center;
  gap: 7px;
  justify-content: flex-end;
  margin-top: 9px;
}
article footer button {
  padding: 6px 11px;
  border: 0;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
}
.locate {
  margin-right: auto;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}
.reject {
  background: color-mix(in srgb, #e35a49 14%, var(--surface));
  color: #b74438;
}
.accept {
  background: #d88a26;
  color: white;
}
.object-error {
  margin: 6px 0 0;
  color: var(--el-color-danger);
  font-size: 12px;
}
</style>
