<script setup lang="ts">
/**
 * QuestionRenderer：ask_user_question 渲染器。
 *
 * 两种形态：
 * 1. **可交互（列表内直接作答）**：工具调用等待中（call.status='running'）且能在
 *    interactions store 的 pending 提问批中匹配到本题（call.id = questionId）时，
 *    选项变为可点击（单选互斥/多选叠加）、支持选项「补充」与「其他补充」、
 *    底部「提交回答」按钮走 interactions.answer（与浮窗/决策窗口共用同一份草稿，
 *    批内多题任一卡片作答后任一卡片可提交整批）。提交后交互项进入 resolving/
 *    completed，卡片自动回到只读展示。
 * 2. **历史只读**：视觉沿用 QuestionCard（紫色系 #7c3aed）——
 *    - header 行：indicator + 可选 header + 右侧 AnswerBadge（已回答/已取消/等待中/超时）
 *    - question 正文（pre-wrap）
 *    - 选项列表：单选使用圆形标记，多选使用方形标记，已选项显示勾选态
 *    - 自由文本：将“其他”回答与已选项分开展示
 *
 * 数据来源：
 * - args: JSON 字符串 `{ question, header?, options:[{label,description?}], multiSelect }`（后端契约 types.ts:192）
 * - result: `"用户回答: <label>"` | `"用户回答: <l1>, <l2>"` | `"用户回答: <label>（补充: <note>）"` | `"用户回答: 其他: <text>"` | `"(用户取消了此问题)"`（ask.ts:45-48 / db/question.ts 序列化）
 *
 * 只读形态不修改 store 状态（符合 RendererProps 契约）；可交互形态仅经
 * interactions.answer 提交（错误写入 interactions.errorsById）。
 */
import { computed, ref } from 'vue'
import type { RendererProps } from '../types'
import { parseQuestionAnswer, parseQuestionArgs, findInteractiveQuestion } from './questionDisplay'
import { useInteractionsStore } from '@/application/public'
import { questionsOf } from '@/features/agent/attention/interactionPresentation'
import {
  draftOf,
  toggleOption,
  toggleOther,
  otherOpenOf,
  toggleNoteOpen,
  noteOpenOf,
  onOptionNoteInput,
  onOtherInput,
  questionAnswered,
} from '@/features/agent/attention/useInteractionDrafts'
import ToolDescriptionDisclosure from '../ToolDescriptionDisclosure.vue'

const props = defineProps<RendererProps>()

const interactions = useInteractionsStore()

const args = computed(() => parseQuestionArgs(props.call.args))
const answerState = computed(() =>
  parseQuestionAnswer(props.call.result, props.call.status, args.value),
)

/** 已答问题的直接汇总：用户勾选的选项（单选/多选一致），含「其他」自由文本（若有）。 */
const answerSummary = computed(() => {
  if (answerState.value.kind !== 'answered') return ''
  const labels = answerState.value.labels.join('、')
  const free = answerState.value.freeText
  if (!labels && !free) return ''
  return [labels, free ? `其他：${free}` : ''].filter(Boolean).join('；')
})

/** 可交互匹配：等待中且 pending 提问批命中本题（call.id = questionId）。 */
const interactive = computed(() => findInteractiveQuestion(props.call.id, interactions.pending))
const draft = computed(() => {
  const match = interactive.value
  return match ? draftOf(match.item, match.question.questionId) : null
})
/** 所属提问批的题目总数（>1 时提示需全部作答后提交）。 */
const batchTotal = computed(() =>
  interactive.value ? questionsOf(interactive.value.item).length : 0,
)
/** 「其他」选项项选中态：已展开或已有自由文本（浮窗直接输入时同样点亮）。 */
const otherSelected = computed(() => {
  const match = interactive.value
  if (!match) return false
  const current = draftOf(match.item, match.question.questionId)
  return current.otherOpen || current.freeText.trim().length > 0
})
const objectError = computed(() => {
  const match = interactive.value
  return match ? interactions.errorsById[match.item.interactionId]?.message : undefined
})
const localError = ref<string | null>(null)

/** 当前 chip 是否高亮为"用户选中"（只读形态）。 */
function isSelected(label: string): boolean {
  return answerState.value.kind === 'answered' && answerState.value.labels.includes(label)
}

/** header 右侧 AnswerBadge 文案 + 样式类。 */
const answerBadge = computed<{ text: string; cls: string }>(() => {
  const s = answerState.value
  switch (s.kind) {
    case 'running':
      return interactive.value
        ? { text: '等待回答', cls: 'badge-running' }
        : { text: '等待中…', cls: 'badge-running' }
    case 'cancelled':
      return { text: '已取消', cls: 'badge-cancelled' }
    case 'missing':
      return { text: '无回答', cls: 'badge-missing' }
    case 'answered':
      return { text: '已回答', cls: 'badge-answered' }
  }
  return { text: '状态未知', cls: 'badge-missing' }
})

/** 交互形态提交：整批题目一起提交（草稿全局共享，批内多题各卡片可分别作答）。 */
async function submit(): Promise<void> {
  const match = interactive.value
  if (!match) return
  localError.value = null
  const { item, question } = match
  if (!questionAnswered(item, question)) {
    localError.value = question.multiSelect ? '请至少选择一项或填写回答' : '请选择一项或填写回答'
    return
  }
  const all = questionsOf(item)
  const unansweredOthers = all.filter(
    (q) => q.questionId !== question.questionId && !questionAnswered(item, q),
  )
  if (unansweredOthers.length > 0) {
    localError.value = `本批共 ${all.length} 题，还有 ${unansweredOthers.length} 题未回答：请在本列表其他卡片或待处理窗口中完成后再提交`
    return
  }
  const answers = all.map((q) => {
    const current = draftOf(item, q.questionId)
    return {
      questionId: q.questionId,
      selectedLabels: current.selectedLabels,
      ...(Object.keys(current.optionNotes).length ? { optionNotes: current.optionNotes } : {}),
      ...(current.freeText.trim() ? { freeText: current.freeText.trim() } : {}),
    }
  })
  try {
    await interactions.answer(item, answers)
  } catch {
    // 对象级错误已写入 interactions.errorsById，由 objectError 展示
  }
}
</script>

<template>
  <div class="question-renderer" :class="{ 'is-interactive': !!interactive }">
    <div class="q-head">
      <span class="indicator" aria-hidden="true" />
      <ToolDescriptionDisclosure
        v-if="args"
        class="q-tool-name"
        tool-name="询问用户"
        :tool-key="props.call.name"
        :chat-id="props.chatId"
      />
      <span v-if="args?.header" class="q-header">{{ args.header }}</span>
      <span v-if="args" class="q-kind">{{ args.multiSelect ? '多选' : '单选' }}</span>
      <slot name="risk" />
      <span class="q-badge" :class="answerBadge.cls">{{ answerBadge.text }}</span>
    </div>
    <div v-if="args" class="q-text">{{ args.question }}</div>

    <!-- 提问说明（大模型写的数据）：为什么需要你决定 / 决定后会发生什么 -->
    <div v-if="args && (args.rationale || args.nextStep)" class="q-context">
      <p v-if="args.rationale">
        <span class="q-context-key">为什么需要你决定</span>{{ args.rationale }}
      </p>
      <p v-if="args.nextStep">
        <span class="q-context-key">决定后会发生什么</span>{{ args.nextStep }}
      </p>
    </div>

    <!-- 等待中且命中 pending 提问批：列表内直接作答（草稿与浮窗/决策窗口共享） -->
    <template v-if="interactive">
      <div
        class="q-options q-options-interactive"
        role="group"
        :aria-label="
          interactive.question.multiSelect ? '多选选项（可点击选择）' : '单选选项（可点击选择）'
        "
      >
        <div v-for="opt in interactive.question.options" :key="opt.label" class="q-option-row">
          <button
            type="button"
            class="q-option is-btn"
            :class="{ selected: draft?.selectedLabels.includes(opt.label) }"
            :aria-pressed="draft?.selectedLabels.includes(opt.label) ?? false"
            @click="
              toggleOption(
                interactive.item,
                interactive.question.questionId,
                opt.label,
                interactive.question.multiSelect,
              )
            "
          >
            <span
              class="q-control"
              :class="{ 'is-multi': interactive.question.multiSelect }"
              aria-hidden="true"
            >
              {{ draft?.selectedLabels.includes(opt.label) ? '✓' : '' }}
            </span>
            <span class="q-option-copy">
              <strong>{{ opt.label }}</strong>
              <small v-if="opt.description">{{ opt.description }}</small>
            </span>
            <!-- 「补充」tag：点击才展开该选项的补充输入（不随选中自动出现） -->
            <span
              class="q-note-tag"
              :class="{
                'is-open': noteOpenOf(interactive.item, interactive.question.questionId, opt.label),
              }"
              role="button"
              tabindex="0"
              :aria-pressed="
                noteOpenOf(interactive.item, interactive.question.questionId, opt.label)
              "
              :aria-label="`为选项 ${opt.label} 补充说明`"
              @click.stop="
                toggleNoteOpen(interactive.item, interactive.question.questionId, opt.label)
              "
              @keydown.enter.stop.prevent="
                toggleNoteOpen(interactive.item, interactive.question.questionId, opt.label)
              "
              @keydown.space.stop.prevent="
                toggleNoteOpen(interactive.item, interactive.question.questionId, opt.label)
              "
              >补充</span
            >
          </button>
          <input
            v-if="
              noteOpenOf(interactive.item, interactive.question.questionId, opt.label) &&
              draft?.selectedLabels.includes(opt.label)
            "
            class="q-note-input"
            :value="draft?.optionNotes[opt.label] ?? ''"
            placeholder="为这个选项补充描述（可选）"
            @input="
              onOptionNoteInput(
                interactive.item,
                interactive.question.questionId,
                opt.label,
                ($event.target as HTMLInputElement).value,
              )
            "
          />
        </div>
        <!-- 「其他」也作为选项项（与单选/多选视觉一致）：点击展开自由文本输入；
             单选时与其他选项互斥，多选时可与其他选项共存。 -->
        <div class="q-option-row">
          <button
            type="button"
            class="q-option is-btn is-other"
            :class="{ selected: otherSelected }"
            :aria-pressed="otherSelected"
            @click="toggleOther(interactive.item, interactive.question.questionId)"
          >
            <span
              class="q-control"
              :class="{ 'is-multi': interactive.question.multiSelect }"
              aria-hidden="true"
            >
              {{ otherSelected ? '✓' : '' }}
            </span>
            <span class="q-option-copy">
              <strong>其他</strong>
              <small>填写自己的回答</small>
            </span>
          </button>
          <input
            v-if="otherOpenOf(interactive.item, interactive.question.questionId)"
            class="q-note-input"
            :value="draft?.freeText ?? ''"
            placeholder="填写其他回答（可选）"
            @input="
              onOtherInput(
                interactive.item,
                interactive.question.questionId,
                ($event.target as HTMLInputElement).value,
              )
            "
          />
        </div>
      </div>
      <div class="q-actions">
        <span v-if="batchTotal > 1" class="q-batch-hint"
          >共 {{ batchTotal }} 题 · 全部作答后可提交</span
        >
        <button type="button" class="q-submit" @click="submit">提交回答</button>
      </div>
      <p v-if="localError" class="q-error" role="alert">{{ localError }}</p>
      <p v-if="objectError" class="q-error" role="alert">{{ objectError }}</p>
    </template>

    <!-- 历史只读展示（已答 / 已取消 / 交互数据未命中） -->
    <template v-else>
      <!-- 已答：直接显示用户勾选选项，无需在选项列表中找勾选态 -->
      <p
        v-if="answerState.kind === 'answered' && answerSummary"
        class="q-answer-summary"
        role="status"
      >
        <span class="q-answer-summary-key">已选择</span>
        <span class="q-answer-summary-value">{{ answerSummary }}</span>
      </p>
      <div
        v-if="args && args.options.length > 0"
        class="q-options"
        role="list"
        :aria-label="args.multiSelect ? '多选选项' : '单选选项'"
      >
        <div
          v-for="opt in args.options"
          :key="opt.label"
          class="q-option"
          :class="{ selected: isSelected(opt.label) }"
          role="listitem"
        >
          <span class="q-control" :class="{ 'is-multi': args.multiSelect }" aria-hidden="true">
            {{ isSelected(opt.label) ? '✓' : '' }}
          </span>
          <span class="q-option-copy">
            <strong>{{ opt.label }}</strong>
            <small v-if="opt.description">{{ opt.description }}</small>
          </span>
        </div>
      </div>
      <div v-if="answerState.kind === 'answered' && answerState.freeText" class="q-other-answer">
        <small>其他补充</small>
        <p>{{ answerState.freeText }}</p>
      </div>
      <!-- 解析失败降级：显示原始 result -->
      <pre v-if="!args" class="q-fallback">{{ call.result ?? '(无数据)' }}</pre>
    </template>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.question-renderer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
  /* 宽度贴合内容（最长选项），上限 420px；窄容器（气泡/抽屉）内不溢出 */
  max-width: min(420px, 100%);
  min-width: 160px;
  padding: 8px 10px;
  border: 1px solid rgba(124, 58, 237, 0.28);
  border-radius: 8px;
  // 紫色系容器：随主题深浅翻转（深色下若用固定浅紫 rgba(245,243,255,.6) 会过亮）
  background: color-mix(in srgb, #7c3aed 12%, var(--surface));
  min-width: 180px;
  max-width: 420px;
}
// 交互形态：边框/底色抬亮，明确"可操作"
.question-renderer.is-interactive {
  border-color: rgba(124, 58, 237, 0.5);
  box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.14) inset;
}

.q-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .indicator {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #7c3aed;
    box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.18);
  }

  .q-tool-name {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 600;
  }

  .q-tool-name :deep(.tool-description-trigger) {
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 80%, transparent);
  }

  .q-header {
    color: color-mix(in srgb, var(--ink) 80%, transparent);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .q-kind {
    flex-shrink: 0;
    padding: 1px 5px;
    border: 1px solid rgba(124, 58, 237, 0.2);
    border-radius: 4px;
    color: var(--violet);
    font-size: 12px;
    font-weight: 400;
  }

  .q-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &.badge-answered {
      background: rgba(124, 58, 237, 0.14);
      color: var(--violet);
    }
    &.badge-cancelled {
      background: color-mix(in srgb, var(--info) 14%, transparent);
      color: var(--info);
    }
    &.badge-running {
      background: color-mix(in srgb, var(--warning) 16%, transparent);
      color: var(--warning);
      animation: q-pulse 1.1s ease-in-out infinite;
    }
    &.badge-missing {
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      color: var(--danger);
    }
  }
}

.q-text {
  font-size: 13px;
  font-weight: 400;
  line-height: 1.35;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  white-space: pre-wrap;
  word-break: break-word;
}

// 提问说明（大模型写的数据）：标题 + 说明，弱化展示。
.q-context {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid color-mix(in srgb, var(--violet) 40%, transparent);
  background: color-mix(in srgb, var(--violet) 6%, transparent);

  p {
    margin: 0;
    color: color-mix(in srgb, var(--ink) 68%, transparent);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .q-context-key {
    display: block;
    color: var(--violet);
    font-weight: 600;
  }
}

// 已答直接汇总：勾选选项醒目展示（强调色块 + 紫色文字）。
.q-answer-summary {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin: 0;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--violet) 38%, transparent);
  border-radius: 5px;
  background: var(--violet-soft);
  font-size: 13px;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-word;

  .q-answer-summary-key {
    flex: 0 0 auto;
    font-weight: 600;
    color: var(--violet);
  }
  .q-answer-summary-value {
    color: var(--violet);
  }
}

.q-options {
  display: grid;
  gap: 6px;
}

.q-option {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: start;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 12.5px;
  line-height: 1.3;

  &.selected {
    background: var(--violet-soft);
    border-color: color-mix(in srgb, var(--violet) 45%, transparent);
    color: var(--violet);
  }
}

// 交互形态选项：整行按钮，hover 反馈。
// 三列布局（控制圈 / 选项文字 / 「补充」tag）必须与按钮内子元素一一对应，
// 否则「补充」会被排进隐式第二行撑高选项行。
.q-option.is-btn {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  align-items: start;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  padding: 7px 8px;
  text-align: left;
  cursor: pointer;
  // 显式字号（勿用 font: inherit——简写会重置 font-size 为父级继承值，覆盖 .q-option 的 12.5px）
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.3;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;

  &:hover {
    border-color: color-mix(in srgb, var(--violet) 55%, transparent);
    background: color-mix(in srgb, var(--violet) 7%, var(--surface));
  }
  &:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--violet) 60%, transparent);
    outline-offset: 1px;
  }
  &.selected:hover {
    background: var(--violet-soft);
  }
}

.q-option-row {
  display: grid;
  gap: 5px;
}

.q-control {
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
  margin-top: 1px;
  border: 1px solid rgba(124, 58, 237, 0.5);
  border-radius: 50%;
  color: var(--violet);
  font-weight: 900;
  line-height: 1;

  &.is-multi {
    border-radius: 2px;
  }
}

.q-option-copy {
  min-width: 0;
  display: grid;
  gap: 2px;

  strong {
    overflow-wrap: anywhere;
    font-weight: 400;
  }

  small {
    color: color-mix(in srgb, var(--ink) 58%, transparent);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

// 「补充」tag：选项按钮内第三列、与文字同行顶对齐（不随选中自动展开）
.q-note-tag {
  flex: none;
  justify-self: end;
  align-self: start;
  display: inline-flex;
  align-items: center;
  margin-top: 1px;
  padding: 1px 5px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
  &:hover {
    color: var(--violet);
  }
  &.is-open {
    color: var(--violet);
  }
}

.q-note-input {
  box-sizing: border-box;
  width: 100%;
  margin-top: 2px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  &:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--violet) 55%, var(--border));
  }
}

.q-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.q-batch-hint {
  margin-right: auto;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
  font-size: 12px;
  line-height: 1.4;
}
.q-submit {
  flex: none;
  padding: 6px 14px;
  border: 0;
  border-radius: 6px;
  background: #7c3aed;
  color: #fff;
  font-size: 13.5px;
  line-height: 1.2;
  cursor: pointer;
  transition: filter 120ms ease;
  &:hover {
    filter: brightness(1.1);
  }
  &:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--violet) 60%, transparent);
    outline-offset: 1px;
  }
}
.q-error {
  margin: 2px 0 0;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.4;
}

.q-other-answer {
  padding: 6px 7px;
  border-left: 2px solid rgba(124, 58, 237, 0.55);
  background: rgba(124, 58, 237, 0.08);

  small {
    display: block;
    margin-bottom: 3px;
    color: var(--violet);
    font-weight: 600;
  }

  p {
    margin: 0;
    color: color-mix(in srgb, var(--ink) 82%, transparent);
    font-size: 12.5px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

.q-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}

@keyframes q-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>
