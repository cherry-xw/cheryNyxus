<script setup lang="ts">
/**
 * QuestionCard：ask_user_question 感官选项卡。
 *
 * 触发：question_batch_requested / 权威快照 → store 选中批次中的当前问题。
 * 渲染：
 * 单题只编辑本地草稿；“下一步”把题目标为 ready，最后一题通过 batchAnswer 原子提交。
 * ✕ 表示该题以 cancelled 答案进入同一批次提交。
 * 错误：console.error 上报（规则 12 fail loud），pending 复位允许重试。
 */
import { computed, ref, watch } from "vue";
import { useAgentsStore } from "@/stores";
import type { QuestionItemState } from "@/stores/agents";

/** batch 进度信息（多问题批次时传入，控制"下一步"vs"提交"按钮） */
interface BatchInfo {
  batchId: string;
  total: number;
  readyCount: number;
  isLast: boolean;
}

const props = defineProps<{
  question: QuestionItemState;
  /** 问题所属 chatId */
  chatId: string;
  /** batch 进度信息（可选，单问题时为 null） */
  batchInfo?: BatchInfo | null;
}>();

const agents = useAgentsStore();

// 待提交（「其他」submit / 选项 submit 任一动作进行中；null = idle）
const pending = ref<"other" | "submit" | "cancel" | null>(null);

// 用户已选的 label 集合（单选互斥 / 多选累加）
const selectedLabels = ref<Set<string>>(new Set(props.question.draftAnswer?.selectedLabels ?? []));

// 「其他」inline textarea 输入内容
const otherText = ref(props.question.draftAnswer?.freeText ?? "");

/** 「其他」chip 是否 inline 展开（刷新卡片时保留已有自由文本） */
const otherExpanded = ref(Boolean(otherText.value));

/** 勾选即同步草稿，让 pet 的问号可显示「已勾选、待下一步」中间态。 */
function syncDraft(): void {
  const freeText = otherExpanded.value ? otherText.value.trim() : "";
  const selected = Array.from(selectedLabels.value);
  if (!selected.length && !freeText) {
    agents.updateQuestionDraft(props.chatId, props.question.questionId);
    return;
  }
  agents.updateQuestionDraft(props.chatId, props.question.questionId, {
    selectedLabels: selected,
    ...(freeText ? { freeText } : {}),
  });
}

watch([selectedLabels, otherText, otherExpanded], syncDraft);

/** 统一 submit 条件：「其他」展开且有文本→允许纯 freeText；否则单选=恰好1，多选=≥1 */
const canSubmit = computed(() => {
  if (pending.value !== null) return false;
  if (otherExpanded.value && otherText.value.trim()) return true;
  if (props.question.multiSelect) return selectedLabels.value.size > 0;
  return selectedLabels.value.size === 1;
});

/** footer 按钮文案：仅批次最后一题提交，其余一律进入下一步。 */
const submitLabel = computed(() => props.batchInfo?.isLast ? "提交" : "下一步");

/** 单选 chip 点击：互斥切换（选中则清空，未选中则替换） */
function toggleSingle(label: string): void {
  if (pending.value !== null) return;
  const next = new Set<string>();
  if (!selectedLabels.value.has(label)) next.add(label);
  selectedLabels.value = next;
  // 单选选了具体选项 → 收起「其他」（互斥）
  if (otherExpanded.value) {
    otherExpanded.value = false;
    otherText.value = "";
  }
}

/** 多选 chip 点击：切换选中状态 */
function toggleMulti(label: string): void {
  if (pending.value !== null) return;
  const next = new Set(selectedLabels.value);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  selectedLabels.value = next;
}

/** 统一 Submit："下一步"模式保存 draft 后决定提交或切下一个 */
async function advanceOrSubmit(): Promise<void> {
  if (!canSubmit.value || pending.value !== null) return;
  pending.value = "submit";
  try {
    const draft: { selectedLabels: string[]; freeText?: string } = {
      selectedLabels: Array.from(selectedLabels.value),
    };
    if (otherExpanded.value && otherText.value.trim()) {
      draft.freeText = otherText.value.trim();
    }

    await agents.advanceQuestion(props.chatId, props.question.questionId, draft);
  } catch (e) {
    console.error(`[QuestionCard] submit failed (id=${props.question.questionId}):`, e);
  } finally {
    // 成功/失败均复位 pending；成功路径不复位会致所有 chip 永久 disabled（bug2）
    pending.value = null;
  }
}

function toggleOther(): void {
  if (pending.value !== null) return;
  otherExpanded.value = !otherExpanded.value;
  if (!otherExpanded.value) {
    otherText.value = "";
  } else if (!props.question.multiSelect) {
    // 单选：「其他」与具体选项互斥，展开即清空已选
    selectedLabels.value = new Set();
  }
}

/** ✕ 关闭：将当前题记为取消答案；整批仍在最后一步原子提交。 */
async function cancel(): Promise<void> {
  if (pending.value !== null) return;
  pending.value = "cancel";
  try {
    await agents.cancelQuestion(props.chatId, props.question.questionId);
  } catch (e) {
    console.error(`[QuestionCard] cancel failed (id=${props.question.questionId}):`, e);
    pending.value = null;
  }
}
</script>

<template>
  <div
    class="question-card"
    role="group"
    :aria-label="`Question: ${question.question}`"
  >
    <div class="header">
      <span class="indicator" aria-hidden="true" />
      <span v-if="question.header" class="header-text">{{ question.header }}</span>
      <span class="type-tag" :class="{ 'is-multi': question.multiSelect }">{{ question.multiSelect ? "多选" : "单选" }}</span>
      <button
        type="button"
        class="close-btn"
        :disabled="pending !== null"
        aria-label="取消问题"
        title="取消（向 AI 反馈用户跳过此问题）"
        @click="cancel"
      >✕</button>
    </div>
    <div class="question-text">{{ question.question }}</div>
    <div class="options">
      <button
        v-for="opt in question.options"
        :key="opt.label"
        type="button"
        class="chip"
        :class="{
          selected: selectedLabels.has(opt.label),
          disabled: pending !== null,
          'is-multi': question.multiSelect,
          'is-single': !question.multiSelect,
        }"
        :title="opt.description ?? opt.label"
        :disabled="pending !== null"
        @click="question.multiSelect ? toggleMulti(opt.label) : toggleSingle(opt.label)"
      >{{ opt.label }}</button>
      <button
        type="button"
        class="chip other"
        :class="{
          selected: otherExpanded,
          disabled: pending !== null,
          'is-multi': question.multiSelect,
          'is-single': !question.multiSelect,
        }"
        :disabled="pending !== null"
        title="「其他」+ 自由文本输入"
        @click="toggleOther"
      >其他</button>
    </div>
    <div v-if="otherExpanded" class="other-input">
      <el-input
        v-model="otherText"
        type="textarea"
        :autosize="{ minRows: 2, maxRows: 5 }"
        placeholder="其他（Ctrl+Enter 提交）"
        :disabled="pending !== null"
        maxlength="500"
        @keydown.enter.ctrl="advanceOrSubmit"
        @keydown.enter.meta="advanceOrSubmit"
      />
    </div>
    <div class="footer">
      <button
        type="button"
        class="btn submit"
        :disabled="!canSubmit || pending !== null"
        @click="advanceOrSubmit"
      >{{ submitLabel }}{{ otherExpanded ? "" : ` (${selectedLabels.size})` }}</button>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.question-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 160px;
  max-width: 240px;
}

.header {
  display: flex;
  align-items: center;
  gap: 5px;

  .indicator {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #7c3aed;
    box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.18);
  }

  .header-text {
    color: #23242a;
    font-size: 11px;
    font-weight: 800;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .type-tag {
    padding: 1px 7px;
    border-radius: 999px;
    background: rgba(124, 58, 237, 0.12);
    color: #6d28d9;
    font-size: 9px;
    font-weight: 800;
    flex-shrink: 0;

    &.is-multi {
      border-radius: 4px;
      background: rgba(37, 99, 235, 0.12);
      color: #2563eb;
    }
  }

  .countdown {
    margin-left: auto;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(124, 58, 237, 0.12);
    color: #6d28d9;
    font-size: 9px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;

    &.expired {
      background: rgba(239, 68, 68, 0.14);
      color: #b91c1c;
    }
  }

  .close-btn {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid rgba(36, 38, 45, 0.16);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.7);
    color: fade(@ink, 56%);
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    transition: background 100ms ease, color 100ms ease;

    &:hover:not(:disabled) {
      background: #fff;
      color: fade(@ink, 86%);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.4;
    }
  }
}

.question-text {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
  color: @ink;
  white-space: pre-wrap;
  word-break: break-word;
}

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 7px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  color: @ink;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    opacity 120ms ease;

  &:hover:not(:disabled) {
    background: rgba(124, 58, 237, 0.06);
    border-color: rgba(124, 58, 237, 0.4);
  }

  &.selected {
    background: rgba(124, 58, 237, 0.14);
    border-color: rgba(124, 58, 237, 0.55);
    color: #5b21b6;
  }

  &.other {
    background: rgba(255, 255, 255, 0.6);
    color: fade(@ink, 70%);
    border-style: dashed;
  }

  // 「其他」选中（otherExpanded）：.other 在 .selected 之后定义会覆盖其背景，此处显式补回高亮
  &.other.selected {
    background: rgba(124, 58, 237, 0.14);
    border-color: rgba(124, 58, 237, 0.55);
    color: #5b21b6;
    border-style: dashed;
  }

  &.is-multi {
    border-radius: 5px;

    &:hover:not(:disabled) {
      background: rgba(37, 99, 235, 0.06);
      border-color: rgba(37, 99, 235, 0.4);
    }

    &.selected,
    &.other.selected {
      background: rgba(37, 99, 235, 0.14);
      border-color: rgba(37, 99, 235, 0.55);
      color: #1d4ed8;
    }
  }

  &.disabled,
  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}

.other-input {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
  width: 100%;
  :deep(.el-textarea__inner) {
    font-size: 11px;
  }
}

.footer {
  display: flex;
  justify-content: flex-end;
}

.btn {
  padding: 3px 10px;
  border: 1px solid;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 800;
  cursor: pointer;
  transition:
    background 120ms ease,
    opacity 120ms ease;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  &.submit {
    border-color: #7c3aed;
    background: #ede9fe;
    color: #5b21b6;

    &:hover:not(:disabled) {
      background: #ddd6fe;
    }
  }
}
</style>
