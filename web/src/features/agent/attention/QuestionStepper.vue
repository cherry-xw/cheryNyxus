<script setup lang="ts">
/**
 * QuestionStepper —— 提问批次的问题步进器（纯展示）。
 *
 * 横向进度点（●─○─○）+ `Q1/3` + 当前题标题；「上一题/下一题」箭头翻题。
 * 无 drafts / store 依赖：answeredFlags 由父级按当前任务草稿计算后传入，
 * 翻题/选题经 emit 交回父级（activeQuestionByInteraction 单一 owner 在父级）。
 */
export interface StepperQuestion {
  questionId: string
  question: string
  header?: string
}

const props = defineProps<{
  questions: StepperQuestion[]
  activeIndex: number
  answeredFlags: boolean[]
}>()

const emit = defineEmits<{
  select: [index: number]
  prev: []
  next: []
}>()

function titleOf(index: number): string {
  const question = props.questions[index]
  if (!question) return ''
  return question.header || question.question
}
</script>

<template>
  <nav class="question-stepper" aria-label="问题步进">
    <button
      type="button"
      class="step-arrow"
      :disabled="activeIndex <= 0"
      aria-label="上一题"
      @click="emit('prev')"
    >
      ◀
    </button>

    <ol class="stepper-dots">
      <li v-for="(question, index) in questions" :key="question.questionId">
        <button
          type="button"
          class="step-dot"
          :class="{
            'is-active': index === activeIndex,
            'is-answered': answeredFlags[index],
          }"
          :aria-current="index === activeIndex ? 'step' : undefined"
          :title="titleOf(index)"
          :aria-label="`第 ${index + 1} 题：${titleOf(index)}`"
          @click="emit('select', index)"
        >
          {{ index + 1 }}
        </button>
      </li>
    </ol>

    <span class="stepper-meta">
      <span class="stepper-count">Q{{ activeIndex + 1 }}/{{ questions.length }}</span>
      <span v-if="titleOf(activeIndex)" class="stepper-title">{{ titleOf(activeIndex) }}</span>
    </span>

    <button
      type="button"
      class="step-arrow"
      :disabled="activeIndex >= questions.length - 1"
      aria-label="下一题"
      @click="emit('next')"
    >
      ▶
    </button>
  </nav>
</template>

<style scoped lang="less">
.question-stepper {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 16%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--nx-text) 3%, transparent);
}

.step-arrow {
  flex-shrink: 0;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--nx-text) 62%, transparent);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    color 120ms ease;
  &:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--nx-green) 40%, transparent);
    color: var(--nx-text);
  }
  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
}

.stepper-dots {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step-dot {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 24%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--nx-bg) 92%, var(--nx-text) 6%);
  color: color-mix(in srgb, var(--nx-text) 60%, transparent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease;
  &:hover {
    border-color: color-mix(in srgb, var(--nx-text) 44%, transparent);
  }
  // 已答题：数字实心（accent 绿底），一眼可辨进度。
  &.is-answered {
    border-color: color-mix(in srgb, var(--nx-green) 58%, transparent);
    background: color-mix(in srgb, var(--nx-green) 22%, transparent);
    color: var(--nx-green);
  }
  // 当前题：描边高亮。
  &.is-active {
    border-color: color-mix(in srgb, var(--nx-green) 72%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--nx-green) 30%, transparent);
    color: var(--nx-text);
  }
}

.stepper-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.stepper-count {
  flex-shrink: 0;
  color: var(--nx-green);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.stepper-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--nx-text);
  font-size: 13px;
}

:global(html[data-theme='light'] .step-dot.is-active) {
  border-color: color-mix(in srgb, var(--nx-cyan) 70%, transparent);
  box-shadow: 0 0 10px color-mix(in srgb, var(--nx-cyan) 9%, transparent);
}
:global(html[data-theme='light'] .step-dot.is-answered) {
  border-color: color-mix(in srgb, var(--nx-cyan) 58%, transparent);
  background: color-mix(in srgb, var(--nx-cyan) 12%, transparent);
  color: var(--nx-cyan);
}
</style>
