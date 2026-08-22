<script setup lang="ts">
/**
 * QuestionCard：ask_user_question 感官选项卡。
 *
 * 触发：question_batch_requested / 权威快照 → store 选中批次中的当前问题。
 * 渲染：
 * 单题只编辑本地草稿；“下一步”把题目标为 ready，最后一题通过 batchAnswer 原子提交。
 * 「跳过」按钮把该题以 cancelled 答案进入同一批次提交。
 * 错误：console.error 上报 + submitError 展示（规则 12 fail loud），pending 复位允许重试。
 */
import { computed, ref, watch } from 'vue'
import { useChatSessionsStore } from '@/stores'
import type { QuestionItemState } from '@/stores/agents'

/** batch 进度信息（多问题批次时传入，控制"下一步"vs"提交"按钮） */
interface BatchInfo {
  batchId: string
  total: number
  readyCount: number
  currentIndex: number
  isLast: boolean
}

const props = defineProps<{
  question: QuestionItemState
  /** 问题所属 chatId */
  chatId: string
  /** batch 进度信息（可选，单问题时为 null） */
  batchInfo?: BatchInfo | null
  variant?: 'default' | 'bubble' | 'paper'
  /** 是否显示自带标题区（问题标题行）。工作台询问节点场景由 popover 独立渲染标题，传 false 隐藏避免重复。 */
  showHeading?: boolean
}>()

const chatSessions = useChatSessionsStore()

// 待提交（「其他」submit / 选项 submit 任一动作进行中；null = idle）
const pending = ref<'other' | 'submit' | 'cancel' | null>(null)
const submitError = ref('')

// 用户已选的 label 集合（单选互斥 / 多选累加）
const selectedLabels = ref<Set<string>>(new Set(props.question.draftAnswer?.selectedLabels ?? []))

// 「其他」inline textarea 输入内容
const otherText = ref(props.question.draftAnswer?.freeText ?? '')

/** 「其他」chip 是否 inline 展开（刷新卡片时保留已有自由文本） */
const otherExpanded = ref(Boolean(otherText.value))

/** 勾选即同步草稿，让 pet 的问号可显示「已勾选、待下一步」中间态。 */
function syncDraft(): void {
  const freeText = otherExpanded.value ? otherText.value.trim() : ''
  const selected = Array.from(selectedLabels.value)
  if (!selected.length && !freeText) {
    chatSessions.updateQuestionDraft(props.chatId, props.question.questionId)
    return
  }
  chatSessions.updateQuestionDraft(props.chatId, props.question.questionId, {
    selectedLabels: selected,
    ...(freeText ? { freeText } : {}),
  })
}

watch([selectedLabels, otherText, otherExpanded], syncDraft)

// Bug 3 修复：进入新问题（"下一步"推进，questionId 变化）时重置本地草稿态——
// 新问题节点与上一题完全无关联。工作台 popover 用 :key=batchId 复用组件实例，
// questionId 变化即代表切换题目；pet 气泡同样经 store 切换 question 对象。
watch(
  () => props.question.questionId,
  () => {
    selectedLabels.value = new Set(props.question.draftAnswer?.selectedLabels ?? [])
    otherText.value = props.question.draftAnswer?.freeText ?? ''
    otherExpanded.value = Boolean(otherText.value)
    pending.value = null
    submitError.value = ''
  },
)

/** 统一 submit 条件：「其他」展开且有文本→允许纯 freeText；否则单选=恰好1，多选=≥1 */
const canSubmit = computed(() => {
  if (pending.value !== null) return false
  if (otherExpanded.value && otherText.value.trim()) return true
  if (props.question.multiSelect) return selectedLabels.value.size > 0
  return selectedLabels.value.size === 1
})

/** header 按钮文案：仅批次最后一题提交，其余一律进入下一步。 */
const submitLabel = computed(() => (props.batchInfo?.isLast ? '提交' : '下一步'))

/** 「上一步」可用：批首题无上一步；提交中禁用（防 race）。 */
const canBack = computed(() => {
  if (pending.value !== null) return false
  if (!props.batchInfo || props.batchInfo.total <= 1) return false
  return props.batchInfo.currentIndex > 0
})

/** 单选 chip 点击：互斥切换（选中则清空，未选中则替换） */
function toggleSingle(label: string): void {
  if (pending.value !== null) return
  const next = new Set<string>()
  if (!selectedLabels.value.has(label)) next.add(label)
  selectedLabels.value = next
  // 单选选了具体选项 → 收起「其他」（互斥）
  if (otherExpanded.value) {
    otherExpanded.value = false
    otherText.value = ''
  }
}

/** 多选 chip 点击：切换选中状态 */
function toggleMulti(label: string): void {
  if (pending.value !== null) return
  const next = new Set(selectedLabels.value)
  if (next.has(label)) next.delete(label)
  else next.add(label)
  selectedLabels.value = next
}

/** 统一 Submit："下一步"模式保存 draft 后决定提交或切下一个 */
async function advanceOrSubmit(): Promise<void> {
  if (!canSubmit.value || pending.value !== null) return
  pending.value = 'submit'
  submitError.value = ''
  try {
    const draft: { selectedLabels: string[]; freeText?: string } = {
      selectedLabels: Array.from(selectedLabels.value),
    }
    if (otherExpanded.value && otherText.value.trim()) {
      draft.freeText = otherText.value.trim()
    }

    await chatSessions.advanceQuestion(props.chatId, props.question.questionId, draft)
  } catch (e) {
    console.error(`[QuestionCard] submit failed (id=${props.question.questionId}):`, e)
    submitError.value = '提交失败，请重试'
  } finally {
    // 成功/失败均复位 pending；成功路径不复位会致所有 chip 永久 disabled（bug2）
    pending.value = null
  }
}

function toggleOther(): void {
  if (pending.value !== null) return
  otherExpanded.value = !otherExpanded.value
  if (!otherExpanded.value) {
    otherText.value = ''
  } else if (!props.question.multiSelect) {
    // 单选：「其他」与具体选项互斥，展开即清空已选
    selectedLabels.value = new Set()
  }
}

/** 「跳过」：将当前题记为取消答案；整批仍在最后一步原子提交。 */
async function cancel(): Promise<void> {
  if (pending.value !== null) return
  pending.value = 'cancel'
  submitError.value = ''
  try {
    await chatSessions.cancelQuestion(props.chatId, props.question.questionId)
  } catch (e) {
    console.error(`[QuestionCard] cancel failed (id=${props.question.questionId}):`, e)
    submitError.value = '提交失败，请重试'
  } finally {
    // 成功/失败均复位 pending；成功路径不复位会致 store guard 静默 return 时整卡永久 disabled
    pending.value = null
  }
}

/** 「上一步」：撤回当前题 ready → pending，并切到同批上一题。无 store await，纯本地焦点切换。 */
function back(): void {
  if (!canBack.value) return
  chatSessions.backQuestion(props.chatId, props.question.questionId)
}
</script>

<template>
  <section
    class="question-card"
    :class="`is-${variant ?? 'default'}`"
    role="group"
    :aria-label="`问题：${question.question}`"
  >
    <header v-if="showHeading !== false" class="question-heading">
      <span class="question-symbol" aria-hidden="true">?</span>
      <span class="heading-copy">
        <span class="heading-kicker">{{ question.header || '需要你的选择' }}</span>
        <span class="question-text">{{ question.question }}</span>
      </span>
      <span v-if="batchInfo && batchInfo.total > 1" class="question-progress">
        {{ batchInfo.currentIndex + 1 }} / {{ batchInfo.total }}
      </span>
    </header>

    <div
      class="options"
      role="listbox"
      :aria-multiselectable="question.multiSelect ? 'true' : 'false'"
    >
      <button
        v-for="opt in question.options"
        :key="opt.label"
        type="button"
        class="option-card"
        :class="{
          selected: selectedLabels.has(opt.label),
          disabled: pending !== null,
          'is-multi': question.multiSelect,
          'is-single': !question.multiSelect,
        }"
        role="option"
        :aria-selected="selectedLabels.has(opt.label)"
        :disabled="pending !== null"
        @click="question.multiSelect ? toggleMulti(opt.label) : toggleSingle(opt.label)"
      >
        <span class="choice-mark" aria-hidden="true">
          <span v-if="selectedLabels.has(opt.label)">✓</span>
        </span>
        <span class="option-copy">
          <span class="option-label">{{ opt.label }}</span>
          <span v-if="opt.description" class="option-description">{{ opt.description }}</span>
        </span>
      </button>
      <button
        type="button"
        class="option-card other"
        :class="{
          selected: otherExpanded,
          disabled: pending !== null,
          'is-multi': question.multiSelect,
          'is-single': !question.multiSelect,
        }"
        role="option"
        :aria-selected="otherExpanded"
        :disabled="pending !== null"
        @click="toggleOther"
      >
        <span class="choice-mark" aria-hidden="true">
          <span v-if="otherExpanded">✓</span>
        </span>
        <span class="option-copy">
          <span class="option-label">其他</span>
          <span class="option-description">用自己的话补充回答</span>
        </span>
      </button>
    </div>

    <div v-if="otherExpanded" class="other-input">
      <el-input
        v-model="otherText"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 5 }"
        placeholder="输入你的回答（Ctrl/Cmd + Enter 提交）"
        :disabled="pending !== null"
        maxlength="500"
        @keydown.enter.ctrl="advanceOrSubmit"
        @keydown.enter.meta="advanceOrSubmit"
      />
    </div>
    <div v-if="submitError" class="submit-error" role="alert">{{ submitError }}</div>

    <footer class="question-actions">
      <button
        v-if="batchInfo && batchInfo.total > 1"
        type="button"
        class="action-btn secondary back"
        :disabled="!canBack"
        @click="back"
      >
        <span aria-hidden="true">←</span> 上一步
      </button>
      <span class="action-spacer" />
      <button
        type="button"
        class="action-btn ghost skip"
        :disabled="pending !== null"
        @click="cancel"
      >
        跳过
      </button>
      <button
        type="button"
        class="action-btn primary submit"
        :disabled="!canSubmit || pending !== null"
        @click="advanceOrSubmit"
      >
        <span>{{ pending === 'submit' ? '处理中…' : submitLabel }}</span>
        <span v-if="pending !== 'submit'" aria-hidden="true">→</span>
      </button>
    </footer>
  </section>
</template>

<style scoped lang="less">
@ink: var(--ink);

.question-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 260px;
  max-width: 360px;
  padding: 16px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 16px;
  color: @ink;
  background: var(--surface-hover);
  box-shadow: 0 18px 46px rgba(20, 22, 26, 0.2);
}
.question-card.is-bubble {
  /* bubble 模式（pet 提问气泡内）：去卡片自身边框/背景/圆角/阴影/最小宽度，由外层
     .speech.question-bubble 统一承载框架；width:100% 跟随气泡宽度，避免内层溢出外层。 */
  min-width: 0;
  max-width: none;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.question-card.is-paper {
  --ink: #342312;
  --surface-hover: #ead5a2;
  --surface-soft: #dfc58d;
  --border: #785934;
  width: 100%;
  min-width: 0;
  max-width: none;
  padding: 12px;
  border: 3px solid #352215;
  border-radius: 0;
  color: var(--ink);
  background:
    repeating-linear-gradient(0deg, transparent 0 7px, rgba(70, 42, 19, 0.05) 7px 8px), #dfc790;
  box-shadow: 5px 6px 0 rgba(28, 16, 8, 0.38);
  font-family: 'HYPixel Paper', system-ui, sans-serif;
}
.question-card.is-paper .question-symbol,
.question-card.is-paper .action-btn.primary {
  border-radius: 0;
  color: #f1deb1;
  background: #654a82;
  box-shadow: 2px 3px 0 rgba(37, 23, 13, 0.32);
}
.question-card.is-paper .option-card,
.question-card.is-paper .action-btn,
.question-card.is-paper :deep(.el-textarea__inner) {
  border-radius: 0;
  font-family: inherit;
}
.submit-error {
  color: color-mix(in srgb, #dc2626 80%, var(--ink));
  font-size: 11px;
  font-weight: 400;
}
.question-heading {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.question-symbol {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  color: var(--ink);
  background: linear-gradient(145deg, #7c3aed, #4f46e5);
  box-shadow: 0 6px 16px rgba(91, 33, 182, 0.28);
  font-size: 15px;
  font-weight: 900;
}
.heading-copy {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
}
.heading-kicker {
  color: color-mix(in srgb, #6d28d9 78%, var(--ink));
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.question-progress {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 999px;
  color: color-mix(in srgb, #5b21b6 80%, var(--ink));
  font-size: 9px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.question-text {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  color: @ink;
  white-space: pre-wrap;
  word-break: break-word;
}

.options {
  display: grid;
  gap: 7px;
}

.option-card {
  appearance: none;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-soft);
  color: @ink;
  text-align: left;
  cursor: pointer;
  transition:
    transform 120ms ease,
    background-color 120ms ease,
    border-color 120ms ease,
    box-shadow 120ms ease;

  &:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: rgba(124, 58, 237, 0.44);
    background: var(--surface-hover);
    box-shadow: 0 5px 14px rgba(42, 33, 86, 0.09);
  }

  &.selected {
    border-color: rgba(91, 33, 182, 0.68);
    background: linear-gradient(120deg, rgba(124, 58, 237, 0.13), rgba(79, 70, 229, 0.06));
    box-shadow: inset 3px 0 0 #7c3aed;
  }

  &.is-multi {
    .choice-mark {
      border-radius: 5px;
    }
  }

  &.disabled,
  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}
.choice-mark {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid color-mix(in srgb, var(--ink) 28%, transparent);
  border-radius: 50%;
  color: var(--ink);
  background: var(--surface-soft);
  font-size: 11px;
  font-weight: 900;
}
.option-card.selected .choice-mark {
  border-color: var(--ink);
  border-color: #6d28d9;
  background: #6d28d9;
}
.option-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.option-label {
  font-size: 11px;
  font-weight: 400;
  line-height: 1.25;
}
.option-description {
  color: color-mix(in srgb, var(--ink) 58%, transparent);
  font-size: 9px;
  font-weight: 400;
  line-height: 1.35;
}

.other-input {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
  width: 100%;
  :deep(.el-textarea__inner) {
    min-height: 62px !important;
    border-radius: 10px;
    box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.24) inset;
    font-size: 11px;
  }
}

.question-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 2px;
}
.action-spacer {
  flex: 1;
}
.action-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition:
    transform 120ms ease,
    background-color 120ms ease,
    border-color 120ms ease,
    opacity 120ms ease;

  &:hover:not(:disabled) {
    transform: translateY(-1px);
  }
  &:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }
  &.primary {
    min-width: 76px;
    color: var(--ink);
    background: linear-gradient(135deg, #7c3aed, #4f46e5);
    box-shadow: 0 6px 15px rgba(91, 33, 182, 0.24);
  }
  &.secondary {
    border-color: var(--border);
    color: color-mix(in srgb, var(--ink) 72%, transparent);
    background: var(--surface-soft);
  }
  &.ghost {
    color: color-mix(in srgb, var(--ink) 55%, transparent);
    background: transparent;
    font-weight: 400;
  }
}

// 卡牌阅读模式使用像素字体，字号过小时会丢失笔画；仅在卡牌卡内提升可读性。
.question-card.is-paper {
  .question-symbol {
    width: 32px;
    height: 32px;
    font-size: 18px;
  }
  .heading-kicker,
  .question-progress {
    font-size: var(--paper-font-small, 11px);
  }
  .question-text {
    font-size: 15px;
    line-height: 1.5;
  }
  .option-card {
    min-height: 50px;
  }
  .choice-mark {
    width: 21px;
    height: 21px;
    font-size: var(--paper-font-body, 13px);
  }
  .option-label,
  :deep(.el-textarea__inner) {
    font-size: var(--paper-font-body, 13px);
  }
  .option-description,
  .submit-error,
  .action-btn {
    font-size: var(--paper-font-small, 11px);
  }
  .action-btn {
    min-height: 38px;
  }
}
</style>
