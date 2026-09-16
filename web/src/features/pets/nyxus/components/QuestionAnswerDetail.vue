<script setup lang="ts">
/**
 * QuestionAnswerDetail：询问工具（ask_user_question）回答的只读展示（节点树 hover 弹窗正文）。
 * - 已选选项显示勾选态；用户为选中选项补充的描述（notes）显示在对应选项框内；
 * - 单选仅有用户自由输入时，输入作为一条勾选选项展示（虚线外框差异化），无值不显示；
 * - 多选的「其他」自由文本仍作为独立补充回答展示。
 */
import { computed } from 'vue'
import type {
  QuestionAnswerView,
  QuestionArgsView,
} from '@/features/agent/renderers/core/questionDisplay'

const props = defineProps<{
  args: QuestionArgsView | null
  answer: QuestionAnswerView
  /** args 解析失败时展示的原始工具参数。 */
  rawArguments: unknown
}>()

/** 该选项是否为用户选中项。 */
function isSelected(label: string): boolean {
  return props.answer.kind === 'answered' && props.answer.labels.includes(label)
}

/** 单选回答仅有用户自由输入时，把输入作为一条选项展示（勾选态 + 差异化外框）；无值不显示。 */
const freeTextOption = computed(
  () =>
    props.args?.multiSelect !== true &&
    props.answer.kind === 'answered' &&
    Boolean(props.answer.freeText),
)
</script>

<template>
  <section v-if="args" class="question-detail">
    <div class="question-heading">
      <span v-if="args.header">{{ args.header }}</span>
      <small>{{ args.multiSelect ? '多选' : '单选' }}</small>
    </div>
    <p class="question-text">{{ args.question }}</p>
    <div
      class="question-options"
      role="list"
      :aria-label="args.multiSelect ? '多选选项' : '单选选项'"
    >
      <div
        v-for="option in args.options"
        :key="option.label"
        class="question-option"
        :class="{ selected: isSelected(option.label) }"
        role="listitem"
      >
        <span
          class="question-control"
          :class="{ 'is-multi': args.multiSelect }"
          aria-hidden="true"
        >
          {{ isSelected(option.label) ? '✓' : '' }}
        </span>
        <span class="question-option-copy">
          <strong>{{ option.label }}</strong>
          <small v-if="option.description">{{ option.description }}</small>
          <!-- 用户为选中选项补充的描述，显示在选项框内 -->
          <small
            v-if="answer.kind === 'answered' && answer.notes?.[option.label]"
            class="option-note"
          >
            {{ answer.notes?.[option.label] }}
          </small>
        </span>
      </div>
      <!-- 单选：用户自由输入有值时也作为一条选项展示（勾选态 + 差异化外框），无值不显示 -->
      <div v-if="freeTextOption" class="question-option is-user-input" role="listitem">
        <span class="question-control" aria-hidden="true">✓</span>
        <span class="question-option-copy">
          <strong>其他</strong>
          <small class="option-input">{{ answer.freeText }}</small>
        </span>
      </div>
    </div>
    <div
      v-if="args.multiSelect && answer.kind === 'answered' && answer.freeText"
      class="question-other detail-field"
    >
      <small class="detail-label">其他补充</small>
      <div class="detail-value">
        <p>{{ answer.freeText }}</p>
      </div>
    </div>
    <p v-else-if="answer.kind === 'cancelled'" class="question-note">用户已取消该问题。</p>
    <p v-else-if="answer.kind === 'running'" class="question-note">等待用户选择…</p>
    <p v-else-if="answer.kind === 'missing'" class="question-note">
      这次执行没有留下可识别的回答。
    </p>
  </section>
  <pre v-else class="question-fallback">{{ rawArguments }}</pre>
</template>

<style scoped lang="less">
@line: var(--nx-border-soft);
@muted: var(--nx-text-dim);
@accent: var(--nx-cyan);

.question-detail {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
}
.question-heading {
  display: flex;
  align-items: center;
  gap: 7px;
}
.question-heading > span {
  min-width: 0;
  flex: 1;
  color: var(--nx-text);
  font-weight: 600;
  overflow-wrap: anywhere;
  font-size: 14px;
}
.question-heading > small {
  flex: 0 0 auto;
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--nx-purple) 36%, transparent);
  border-radius: 3px;
  color: var(--nx-purple);
  font-size: 12px;
}
.question-text {
  margin: 0;
  color: var(--nx-text);
  font-weight: 600;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--popover-content-font);
}
.question-options {
  display: grid;
  gap: 5px;
}
.question-option {
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  align-items: start;
  gap: 7px;
  padding: 7px 8px;
  border: 1px solid @line;
  border-radius: 3px;
  color: var(--nx-text-dim);
}
.question-option.selected {
  border-color: color-mix(in srgb, var(--nx-purple) 58%, transparent);
  color: var(--nx-purple);
}
// 单选自由文本回答：作为一条选项展示（勾选态），外框用虚线差异化，区别于预置选项。
.question-option.is-user-input {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--nx-purple) 55%, transparent);
  color: var(--nx-purple);
  background: color-mix(in srgb, var(--nx-purple) 5%, transparent);
}
.question-option.is-user-input .question-option-copy small {
  color: var(--nx-purple);
}
.question-control {
  display: grid;
  place-items: center;
  width: 13px;
  height: 13px;
  margin-top: 1px;
  line-height: 0;
  border: 1px solid color-mix(in srgb, var(--nx-purple) 54%, transparent);
  border-radius: 50%;
  color: var(--nx-purple);
  font-weight: 800;
}
.question-control.is-multi {
  border-radius: 2px;
}
.question-option-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.question-option-copy strong {
  font-size: var(--popover-content-font);
  font-weight: 400;
  overflow-wrap: anywhere;
}
.question-option-copy small {
  color: @muted;
  font-size: var(--popover-content-font);
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
// 用户为选中选项补充的描述：选项框内以紫色侧边条区分于预置选项说明。
.question-option-copy .option-note {
  margin-top: 2px;
  padding-left: 5px;
  border-left: 2px solid color-mix(in srgb, var(--nx-purple) 55%, transparent);
  color: var(--nx-purple);
}
.question-other {
  --detail-accent: color-mix(in srgb, var(--nx-purple) 62%, transparent);
}
.detail-field {
  min-width: 0;
}
.detail-label {
  display: block;
  margin: 0 0 4px;
  color: @accent;
  font:
    600 var(--popover-content-font)/1.2 system-ui,
    sans-serif;
  letter-spacing: 0.05em;
}
.detail-value {
  position: relative;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid @line;
  border-left-color: var(--detail-accent, @line);
  border-radius: 3px;
  color: var(--nx-text-dim);
  font-size: var(--popover-content-font);
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.question-other p,
.question-note {
  margin: 0;
  color: var(--nx-text-dim);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.question-note {
  color: @muted;
}
.question-fallback {
  max-width: 100%;
  max-height: 360px;
  margin: 0;
  overflow: auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: var(--nx-text-dim);
  font:
    var(--popover-content-font)/1.55 ui-monospace,
    'JetBrains Mono',
    monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
