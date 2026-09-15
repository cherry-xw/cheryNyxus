<script setup lang="ts">
import type { InteractionRecord } from '@/application/backend/public'
import { useInteractionsStore } from '@/application/public'
import type { PanelQuestion } from './interactionPresentation'
import {
  draftOf,
  noteOpenOf,
  onOptionNoteInput,
  onOtherFocus,
  onOtherInput,
  toggleNoteOpen,
  toggleOption,
} from './useInteractionDrafts'

defineProps<{
  item: InteractionRecord
  question: PanelQuestion
  questionIndex: number
  totalQuestions: number
  disabled: boolean
}>()
const interactions = useInteractionsStore()
</script>

<template>
  <fieldset :disabled="disabled">
    <legend>
      <span v-if="totalQuestions > 1">{{ questionIndex + 1 }}. </span
      >{{ question.header || question.question }}
    </legend>
    <small v-if="question.header && question.header !== question.question">{{
      question.question
    }}</small>
    <p class="options-hint">
      {{ question.multiSelect ? '可多选' : '单选 · 再次点击可取消' }}
    </p>
    <div class="options">
      <div v-for="option in question.options" :key="option.label" class="option-row">
        <button
          type="button"
          class="option-btn"
          :class="{
            selected: draftOf(item, question.questionId).selectedLabels.includes(option.label),
          }"
          @click="toggleOption(item, question.questionId, option.label, question.multiSelect)"
        >
          <span class="option-btn-label">
            <b>{{ option.label }}</b
            ><span v-if="option.description">{{ option.description }}</span>
          </span>
          <!-- 「补充」tag 在选项按钮内部末尾：点选才展开该选项的补充输入（不随选中自动出现） -->
          <span
            class="option-note-tag"
            :class="{ 'is-open': noteOpenOf(item, question.questionId, option.label) }"
            role="button"
            tabindex="0"
            :aria-pressed="noteOpenOf(item, question.questionId, option.label)"
            :aria-label="`为选项 ${option.label} 补充说明`"
            @click.stop="toggleNoteOpen(item, question.questionId, option.label)"
            @keydown.enter.stop.prevent="toggleNoteOpen(item, question.questionId, option.label)"
            @keydown.space.stop.prevent="toggleNoteOpen(item, question.questionId, option.label)"
          >
            补充
          </span>
        </button>
        <input
          v-if="
            noteOpenOf(item, question.questionId, option.label) &&
            draftOf(item, question.questionId).selectedLabels.includes(option.label)
          "
          class="option-note-input"
          :value="draftOf(item, question.questionId).optionNotes[option.label] ?? ''"
          placeholder="为这个选项补充描述（可选）"
          @input="
            onOptionNoteInput(
              item,
              question.questionId,
              option.label,
              ($event.target as HTMLInputElement).value,
            )
          "
        />
      </div>
      <!-- 「其他补充」直接就是输入框：获得焦点即取消单选选项选中（多选可与多选共存） -->
      <input
        :value="draftOf(item, question.questionId).freeText"
        placeholder="其他补充（可选）"
        @focus="onOtherFocus(item, question.questionId)"
        @input="onOtherInput(item, question.questionId, ($event.target as HTMLInputElement).value)"
      />
    </div>
    <p
      v-if="interactions.questionErrorsById[item.interactionId]?.[question.questionId]"
      class="object-error"
      role="alert"
    >
      {{
        interactions.questionErrorsById[item.interactionId]?.[question.questionId]?.message
      }}
    </p>
  </fieldset>
</template>

<style scoped lang="less">
fieldset {
  margin: 10px 0;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 9px;
}
legend {
  padding: 0 4px;
  font-size: 13px;
  font-weight: 400;
}
fieldset > small {
  display: block;
  margin-bottom: 7px;
  font-size: 12px;
  opacity: 0.88;
}
.options-hint {
  margin: 0 0 6px;
  font-size: 12px;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
}
.options {
  display: grid;
  gap: 5px;
}
.option-row {
  display: grid;
  gap: 5px;
}
// 选项按钮：左侧文本 + 末尾「补充」tag（flex 两端布局）。
.options button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.option-btn-label {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.options button b {
  font-weight: 400;
}
.options button.selected {
  border-color: #c98224;
  background: color-mix(in srgb, var(--accent) 20%, var(--surface));
}
.option-btn-label span {
  font-size: 12px;
  opacity: 0.72;
}
// 选项按钮内部末尾的「补充」tag：点选才展开该选项的补充输入（不随选中自动出现）。
// 无边框纯文字标签，新元素直角、400 字重、token 派生色；fieldset 禁用时不可点。
.option-note-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  font-size: 12px;
  text-align: center;
  cursor: pointer;
}
.option-note-tag:hover {
  color: var(--accent);
}
.option-note-tag.is-open {
  color: var(--accent);
}
fieldset:disabled .option-note-tag {
  pointer-events: none;
  opacity: 0.5;
}
input {
  box-sizing: border-box;
  width: 100%;
  margin-top: 6px;
  padding: 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 13%, transparent);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
}
.option-note-input {
  margin-top: 0;
}
.object-error {
  margin: 6px 0 0;
  color: var(--el-color-danger);
  font-size: 12px;
}
</style>
