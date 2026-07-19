<script setup lang="ts">
/**
 * PetBubbles：所有气泡 AnimatePresence 块（question / approval / error / work-main / speech / side-thinking）。
 * 接收 useStreamBubble 的展示状态 + usePetStyles 的样式/motion 计算值。
 * 支持可选 dialog 插槽透传（speech 气泡内）。
 *
 * 优先级：question > approval > error > work-main > speech。
 *  问题阻塞 LLM 主线程，最高优先级；审批可入队延后处理。
 */
import { AnimatePresence, motion } from 'motion-v'
import { computed } from 'vue'
import type { VariantType } from 'motion-v'
import ApprovalCard from '@/features/agent/ApprovalCard.vue'
import QuestionCard from '@/features/agent/QuestionCard.vue'
import type { StreamState } from '@/stores'
import type { QuestionItemState } from '@/stores/agents'
import { findQuestion } from '@/stores/agents/questionBatch'
import type { PetInstance } from './types'

const MotionDiv = motion.div

defineEmits<{
  bubbleEnter: []
  bubbleLeave: []
}>()

const props = defineProps<{
  pet: PetInstance
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

/**
 * activeQuestion：根据 stream.activeQuestionId 从 questions[] 查找当前选中问题。
 * batchInfo：当前 question 所属 batch 的进度信息（控制"下一步"vs"提交"按钮）。
 */
const activeEntry = computed(() => findQuestion(props.stream, props.stream?.activeQuestionId))
const activeQuestion = computed<QuestionItemState | null>(() => activeEntry.value?.question ?? null)

const batchInfo = computed(() => {
  const entry = activeEntry.value
  if (!entry) return null
  return {
    batchId: entry.batch.batchId,
    total: entry.batch.questions.length,
    readyCount: entry.batch.questions.filter((question) => question.localStatus === 'ready').length,
    isLast: !entry.batch.questions.some(
      (question) =>
        question.questionId !== entry.question.questionId && question.localStatus === 'pending',
    ),
  }
})
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="activeQuestion"
      key="question"
      class="speech question-bubble"
      :style="approvalStyle"
      :initial="speech.initial"
      :animate="speech.animate"
      :exit="speech.exit"
      :transition="speech.transition"
    >
      <QuestionCard
        :key="activeQuestion!.questionId"
        :question="activeQuestion!"
        :chat-id="pet.chatId"
        :batch-info="batchInfo"
      />
    </MotionDiv>
    <MotionDiv
      v-else-if="stream?.approval"
      key="approval"
      class="speech approval-bubble"
      :style="approvalStyle"
      :initial="speech.initial"
      :animate="speech.animate"
      :exit="speech.exit"
      :transition="speech.transition"
    >
      <ApprovalCard :approval="stream!.approval!" :chat-id="pet.chatId" />
    </MotionDiv>
    <MotionDiv
      v-else-if="stream?.error"
      key="work-error"
      class="speech work-bubble error-bubble"
      :style="speechStyle"
      :initial="speech.initial"
      :animate="speech.animate"
      :exit="speech.exit"
      :transition="speech.transition"
    >
      <div class="work-text error-text">⚠ {{ stream.error }}</div>
    </MotionDiv>
    <MotionDiv
      v-else-if="showWorkMain"
      key="work-main"
      class="speech work-bubble"
      :class="{ 'is-thinking': thinkingOnly, 'is-sub': !pet.isMaster }"
      :style="speechStyle"
      :initial="speech.initial"
      :animate="speech.animate"
      :exit="speech.exit"
      :transition="speech.transition"
      @pointerenter="$emit('bubbleEnter')"
      @pointerleave="$emit('bubbleLeave')"
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
      <div v-if="showThinkingButton" class="thinking-trigger" aria-label="查看 thinking">
        <span class="thinking-icon" aria-hidden="true">🤔</span>
        <div class="thinking-flyout" role="tooltip">{{ displayThinking }}</div>
      </div>
    </MotionDiv>
    <MotionDiv
      v-else-if="pet.speech || $slots.dialog"
      :key="pet.speechUntil"
      class="speech"
      :style="speechStyle"
      :initial="speech.initial"
      :animate="speech.animate"
      :exit="speech.exit"
      :transition="speech.transition"
    >
      <slot name="dialog" :pet="pet">{{ pet.speech }}</slot>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import '@/styles/markdown.less';
@ink: #14161a;

.speech {
  position: absolute;
  min-width: 28px;
  max-width: 96px;
  padding: 4px 7px;
  border: 1px solid rgba(255, 255, 255, 0.74);
  border-radius: 7px;
  color: #23242a;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.16);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.2;
  overflow-wrap: anywhere;
  transform-origin: center bottom;

  &::after {
    content: '';
    position: absolute;
    left: 14px;
    bottom: -5px;
    width: 8px;
    height: 8px;
    border-right: 1px solid rgba(255, 255, 255, 0.74);
    border-bottom: 1px solid rgba(255, 255, 255, 0.74);
    background: rgba(255, 255, 255, 0.92);
    transform: rotate(45deg);
  }
}

.work-bubble {
  max-width: 180px;
  max-height: 140px;
  padding: 5px 0 5px 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.35;
  overflow: visible; /* 放行 thinking-flyout 溢出；work-text 自身 overflow 裁内容不依赖此处 */
  display: flex;
  flex-direction: column;

  &.is-thinking {
    background: rgba(240, 238, 245, 0.92);
    border-color: rgba(140, 130, 170, 0.4);
    border-style: dashed;
  }

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
    scrollbar-width: thin;
    scrollbar-color: rgba(20, 22, 26, 0.25) transparent;

    &::-webkit-scrollbar {
      width: 4px;
    }
    &::-webkit-scrollbar-track {
      background: transparent;
    }
    &::-webkit-scrollbar-thumb {
      background: rgba(20, 22, 26, 0.25);
      border-radius: 2px;
      &:hover {
        background: rgba(20, 22, 26, 0.4);
      }
    }

    &.is-thinking {
      color: fade(@ink, 64%);
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

  /* thinking 按钮：思考结束后锚 content 气泡左外侧（emoji icon）；hover 向左上拉伸显思考框（盖住按钮），
     鼠标移开 scale(0) 缩回恢复 icon。emoji 黄脸（🤔）作按钮。 */
  .thinking-trigger {
    position: absolute;
    right: 100%; /* content 气泡左外侧 */
    bottom: -1px; /* 贴气泡左下角外侧 */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    line-height: 1;
    cursor: default;
    user-select: none;

    .thinking-icon {
      font-size: 13px;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.15));
      transition: transform 140ms ease;
    }

    &:hover .thinking-icon {
      transform: scale(1.15);
    }

    &:hover .thinking-flyout {
      transform: scale(1);
      opacity: 1;
      pointer-events: auto;
    }
  }

  .thinking-flyout {
    position: absolute;
    right: 0; /* 右沿对齐按钮（= 气泡左沿），向左拉伸 */
    bottom: 0; /* 底对齐按钮，向上拉伸 */
    z-index: 30;
    box-sizing: border-box;
    width: 200px;
    max-height: 150px;
    padding: 5px 7px;
    border-radius: 7px;
    border: 1px dashed rgba(140, 130, 170, 0.4);
    background: rgba(240, 238, 245, 0.97);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
    color: fade(@ink, 64%);
    font-size: 9.5px;
    font-weight: 400;
    font-style: italic;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow: auto;
    text-align: left;
    transform: scale(0); /* 收起：缩成右下角点；hover scale(1) 向左上拉伸展开盖住按钮 */
    transform-origin: bottom right;
    opacity: 0;
    pointer-events: none;
    transition:
      transform 180ms ease,
      opacity 140ms ease;
  }
}

.approval-bubble {
  max-width: 220px;
  padding: 5px 8px;
  background: rgba(255, 248, 235, 0.96);
  border-color: rgba(234, 88, 12, 0.42);
}

.question-bubble {
  max-width: 230px;
  padding: 6px 9px;
  background: rgba(245, 243, 255, 0.96);
  border-color: rgba(124, 58, 237, 0.42);
}

.error-bubble {
  max-width: 240px;
  padding: 6px 10px;
  background: rgba(254, 226, 226, 0.96);
  border-color: rgba(220, 38, 38, 0.55);
  color: #7f1d1d;
}

.error-bubble .error-text {
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
}
</style>
