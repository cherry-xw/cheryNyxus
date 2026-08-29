<script setup lang="ts">
/**
 * PetBubbles：所有气泡 AnimatePresence 块（question / approval / error / work-main / speech / side-thinking）。
 * 接收 useStreamBubble 的展示状态 + usePetStyles 的样式/motion 计算值。
 * 支持可选 dialog 插槽透传（speech 气泡内）。
 *
 * 优先级：question > approval > error > work-main > speech。
 *  问题阻塞 LLM 主线程，最高优先级；审批可入队延后处理。
 *
 * 气泡 motion 包装 + 外壳样式（.speech/.work-bubble/.approval-bubble/.question-bubble/.error-bubble）
 * 委托 PetBubble；思考按钮 + flyout 委托 ThinkingTrigger；本组件保留 .work-text/.error-text 等内容样式
 * （通过组件根 data-v 继承，PetBubble 根匹配 .work-bubble 后下行命中 slot 内 .work-text）。
 */
import { AnimatePresence } from 'motion-v'
import { computed } from 'vue'
import type { VariantType } from 'motion-v'
import ApprovalCard from '@/features/agent/cards/ApprovalCard.vue'
import QuestionCard from '@/features/agent/cards/QuestionCard.vue'
import { useAgentsStore, type StreamState } from '@/application/public'
import type { QuestionItemState } from '@/domain/chat/projectionTypes'
import { findQuestion } from '@/domain/chat/questionProjection'
import type { PetInstance } from '@/domain/pets/types'
import PetBubble from './PetBubble.vue'
import ThinkingTrigger from './ThinkingTrigger.vue'

defineEmits<{
  bubbleEnter: []
  bubbleLeave: []
}>()

const props = defineProps<{
  pet: PetInstance
  /** 本气泡对应 stream 的 chatId（master = 活跃根，子 = 自身），接力棒判定用。 */
  chatId: string
  stream?: StreamState
  // display state (from useStreamBubble)
  hasStream: boolean
  isBusy: boolean
  showWorkMain: boolean
  showThinkingButton: boolean
  thinkingOnly: boolean
  hasContent: boolean
  displayThinking: string
  displayContent: string
  renderedContent: string
  // style computeds
  speechStyle: Record<string, string>
  approvalStyle: Record<string, string>
  // motion configs
  speech: {
    initial: VariantType
    animate: VariantType
    exit: VariantType
    transition: VariantType['transition']
  }
  // scroll handler (from useStreamBubble, bound via workTextRef setter)
  workTextRef: (el: HTMLElement | null) => void
  onWorkTextScroll: (e: Event) => void
}>()

defineSlots<{
  dialog?: (props: { pet: PetInstance }) => unknown
}>()

const agents = useAgentsStore()

/**
 * 接力棒：该 chat 的提问/审批已被某个打开的工作台窗口接管时，pet 气泡隐藏（工作台就地消费），
 * 避免同一交互出现两份窗口；工作台关闭/最小化后自动交还 pet（最终兜底）。
 */
const consumedByWorkbench = computed(() => agents.workbenchConsumesChat(props.chatId))

/**
 * activeQuestion：根据 stream.activeQuestionId 从 questions[] 查找当前选中问题。
 * batchInfo：当前 question 所属 batch 的进度信息（控制"下一步"vs"提交"按钮）。
 */
const activeEntry = computed(() => findQuestion(props.stream, props.stream?.activeQuestionId))
const activeQuestion = computed<QuestionItemState | null>(() => activeEntry.value?.question ?? null)

const batchInfo = computed(() => {
  const entry = activeEntry.value
  if (!entry) return null
  const sorted = [...entry.batch.questions].sort((a, b) => a.position - b.position)
  return {
    batchId: entry.batch.batchId,
    total: entry.batch.questions.length,
    readyCount: entry.batch.questions.filter((question) => question.localStatus === 'ready').length,
    currentIndex: sorted.findIndex((question) => question.questionId === entry.question.questionId),
    isLast: !entry.batch.questions.some(
      (question) =>
        question.questionId !== entry.question.questionId && question.localStatus === 'pending',
    ),
  }
})
</script>

<template>
  <AnimatePresence>
    <PetBubble
      v-if="activeQuestion && !consumedByWorkbench"
      key="question"
      variant="question"
      :speech="speech"
      :style="approvalStyle"
    >
      <QuestionCard
        :key="activeQuestion!.questionId"
        :question="activeQuestion!"
        :chat-id="pet.chatId"
        :batch-info="batchInfo"
        variant="bubble"
      />
    </PetBubble>
    <PetBubble
      v-else-if="stream?.approval && !consumedByWorkbench"
      :key="`approval-${stream.approval.approvalId}`"
      variant="approval"
      :speech="speech"
      :style="approvalStyle"
    >
      <ApprovalCard :approval="stream!.approval!" :chat-id="pet.chatId" />
    </PetBubble>
    <PetBubble
      v-else-if="stream?.error"
      key="work-error"
      variant="error"
      :speech="speech"
      :style="speechStyle"
    >
      <div class="work-text error-text">
        <div>⚠ {{ stream.error }}</div>
        <!-- 上游技术摘要折叠展示（error-conventions.md detail 通道）：默认收起，点开可见 status/body 摘要 -->
        <details v-if="stream.errorFact?.detail" class="error-detail">
          <summary>详情</summary>
          <span class="error-detail-body">{{ stream.errorFact.detail }}</span>
        </details>
      </div>
    </PetBubble>
    <PetBubble
      v-else-if="showWorkMain"
      key="work-main"
      variant="work"
      :speech="speech"
      :style="speechStyle"
      :is-thinking="thinkingOnly"
      :is-sub="!pet.isMaster"
      @enter="$emit('bubbleEnter')"
      @leave="$emit('bubbleLeave')"
    >
      <div
        :ref="(el) => workTextRef(el as HTMLElement | null)"
        class="work-text"
        :class="{ 'is-thinking': thinkingOnly }"
        @scroll="onWorkTextScroll"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义，XSS 安全 -->
        <span v-if="hasContent" class="md" v-html="renderedContent" />
        <template v-else>{{ displayThinking }}</template>
      </div>
      <!-- thinking 按钮：思考结束后出现，锚 content 气泡左外侧（emoji 🤔）；hover 向左上拉伸显思考框（盖住按钮），移开缩回恢复 icon -->
      <ThinkingTrigger v-if="showThinkingButton" :display-thinking="displayThinking" />
    </PetBubble>
    <PetBubble
      v-else-if="pet.speech || $slots.dialog"
      :key="pet.speechUntil"
      variant="speech"
      :speech="speech"
      :style="speechStyle"
    >
      <slot name="dialog" :pet="pet">{{ pet.speech }}</slot>
    </PetBubble>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import '@/styles/markdown.less';
@ink: var(--ink);

/* .work-bubble / .error-bubble 类落在 PetBubble 根（组件根继承父 data-v，
   故本 scoped 选择器仍可命中），其内部 .work-text/.error-text 为本组件 slot 内容。 */
.work-bubble {
  /* 子 pet：流式过程（思考 / 正文打字机）默认单行不可滚，hover 展开可滚 */
  &.is-sub .work-text {
    max-height: 14px;
    overflow: hidden;
  }
  &.is-sub:hover .work-text {
    max-height: 120px;
    overflow: auto;
  }

  .work-text {
    flex: 1;
    overflow: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    font-weight: 400;
    padding-right: 8px;
    .inner-scrollbar(); /* 内层滚动：pet 工作文本，弱化滚动条 */

    &.is-thinking {
      color: color-mix(in srgb, var(--ink) 64%, transparent);
      font-style: italic;
    }

    .md {
      white-space: normal;
      .md-content();
      // bubble-specific overrides (smaller font for compact pet bubble)
      :deep(p) {
        font-size: 10px;
      }
      :deep(h1),
      :deep(h2),
      :deep(h3),
      :deep(h4) {
        font-size: 11px;
      }
      :deep(code) {
        font-size: 9px;
      }
    }
  }
}

.error-bubble .error-text {
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;

  /* detail 折叠：全直角、正文 400；summary 为关键词强调用 600 */
  .error-detail {
    margin-top: 4px;
    border-radius: 0;

    summary {
      cursor: pointer;
      font-weight: 600;
      color: color-mix(in srgb, var(--danger) 80%, var(--ink));
      user-select: none;
    }

    .error-detail-body {
      display: block;
      margin-top: 2px;
      font-weight: 400;
      color: color-mix(in srgb, var(--ink) 78%, var(--danger));
    }
  }
}
</style>
