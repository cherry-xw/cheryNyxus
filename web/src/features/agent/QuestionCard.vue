<script setup lang="ts">
/**
 * QuestionCard：ask_user_question 感官选项卡。
 *
 * 触发：question_requested notification → store routeNotification 设 stream.question。
 * 渲染：
 *   - 单选：选项 chip 行（点击即提交 selectedLabels=[label]，无 Submit 按钮）
 *   - 多选：选项 chip 行 + 底部 Submit 按钮（提交 selectedLabels=[label1,label2,...]）
 *   - 「其他」chip（永远在最后）：点击打开 el-dialog 文本框，Submit 提交 {selectedLabels:[], freeText, cancelled:false}
 *   - ✕ 关闭：提交 {cancelled:true}（handler 收到取消）
 * 倒计时：waitTime（= global.approval_timeout）- (now - createdAt），waitTime=0 不超时不显倒计时。
 * 错误：console.error 上报（规则 12 fail loud），pending 复位允许重试。
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { ElDialog } from "element-plus";
import { agentApi } from "@/services/agentApi";
import { useAgentsStore } from "@/stores";
import type { QuestionState } from "@/stores/agents";

const props = defineProps<{
  question: QuestionState;
  /** 问题所属 chatId（submit 后 dismissQuestion 用） */
  chatId: string;
}>();

const agents = useAgentsStore();

// 待提交（单选 chip / 「其他」submit / 多选 submit 任一动作进行中；null = idle）
const pending = ref<"option" | "other" | "submit" | "cancel" | null>(null);

// 多选：用户已选的 label 集合（点击 chip 切换）
const selectedLabels = ref<Set<string>>(new Set());

// 「其他」对话框显隐
const otherDialogVisible = ref(false);
const otherText = ref("");

// 倒计时：now 每 250ms 刷新驱动 remaining 重算。waitTime=0 不超时不启动定时器。
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
if (props.question.waitTime > 0) {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 250);
}
onBeforeUnmount(() => {
  if (timer !== undefined) clearInterval(timer);
});

const showCountdown = computed(() => props.question.waitTime > 0);
const remainingMs = computed(() =>
  Math.max(0, props.question.waitTime - (now.value - props.question.createdAt)),
);
const remainingSec = computed(() => Math.ceil(remainingMs.value / 1000));
// 倒计时归零：后端超时 cancel 已触发，按所有 chip/submit 禁用等 question_answered notification 兜底
const expired = computed(() => showCountdown.value && remainingMs.value <= 0);

const canSubmitMulti = computed(
  () => props.question.multiSelect && selectedLabels.value.size > 0 && !expired.value,
);
const canSubmitOther = computed(() => !expired.value);

/** 单选 chip 点击：立即提交 selectedLabels=[label] */
async function submitSingle(label: string): Promise<void> {
  if (pending.value !== null) return;
  pending.value = "option";
  try {
    await agentApi.answerQuestion(props.question.questionId, {
      selectedLabels: [label],
    });
    agents.dismissQuestion(props.chatId);
  } catch (e) {
    console.error(`[QuestionCard] answer failed (id=${props.question.questionId}):`, e);
    pending.value = null;
  }
}

/** 多选 chip 点击：切换选中状态 */
function toggleMulti(label: string): void {
  if (pending.value !== null || expired.value) return;
  const next = new Set(selectedLabels.value);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  selectedLabels.value = next;
}

/** 多选 Submit：提交 selectedLabels=[label1,label2,...] */
async function submitMulti(): Promise<void> {
  if (!canSubmitMulti.value || pending.value !== null) return;
  pending.value = "submit";
  try {
    await agentApi.answerQuestion(props.question.questionId, {
      selectedLabels: Array.from(selectedLabels.value),
    });
    agents.dismissQuestion(props.chatId);
  } catch (e) {
    console.error(`[QuestionCard] multi submit failed (id=${props.question.questionId}):`, e);
    pending.value = null;
  }
}

/** 「其他」chip 点击：打开模态对话框 */
function openOtherDialog(): void {
  if (pending.value !== null || expired.value) return;
  otherText.value = "";
  otherDialogVisible.value = true;
}

/** 「其他」对话框 Submit：提交 {selectedLabels:[], freeText} */
async function submitOther(): Promise<void> {
  if (pending.value !== null || !canSubmitOther.value) return;
  const text = otherText.value.trim();
  if (!text) return; // 空文本不允许提交
  pending.value = "other";
  otherDialogVisible.value = false;
  try {
    await agentApi.answerQuestion(props.question.questionId, {
      selectedLabels: [],
      freeText: text,
    });
    agents.dismissQuestion(props.chatId);
  } catch (e) {
    console.error(`[QuestionCard] other submit failed (id=${props.question.questionId}):`, e);
    pending.value = null;
  }
}

/** ✕ 关闭：提交 cancelled:true（handler 收到取消） */
async function cancel(): Promise<void> {
  if (pending.value !== null) return;
  pending.value = "cancel";
  try {
    await agentApi.answerQuestion(props.question.questionId, {
      selectedLabels: [],
      cancelled: true,
    });
    agents.dismissQuestion(props.chatId);
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
      <span v-if="showCountdown" class="countdown" :class="{ expired }">{{ remainingSec }}s</span>
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
          selected: question.multiSelect && selectedLabels.has(opt.label),
          disabled: pending !== null || expired,
        }"
        :title="opt.description ?? opt.label"
        :disabled="pending !== null || expired"
        @click="question.multiSelect ? toggleMulti(opt.label) : submitSingle(opt.label)"
      >
        <span v-if="question.multiSelect && selectedLabels.has(opt.label)" class="check" aria-hidden="true">✓</span>
        {{ opt.label }}
      </button>
      <button
        type="button"
        class="chip other"
        :disabled="pending !== null || expired"
        title="「其他」+ 自由文本输入"
        @click="openOtherDialog"
      >其他</button>
    </div>
    <div v-if="question.multiSelect" class="footer">
      <button
        type="button"
        class="btn submit"
        :disabled="!canSubmitMulti || pending !== null"
        @click="submitMulti"
      >提交 ({{ selectedLabels.size }})</button>
    </div>
  </div>

  <ElDialog
    v-model="otherDialogVisible"
    title="其他输入"
    width="380px"
    :close-on-click-modal="false"
    :close-on-press-escape="!pending"
  >
    <el-input
      v-model="otherText"
      type="textarea"
      :rows="3"
      placeholder="请输入你的回答..."
      :disabled="pending !== null"
      maxlength="500"
      show-word-limit
      @keydown.enter.ctrl="submitOther"
      @keydown.enter.meta="submitOther"
    />
    <template #footer>
      <el-button :disabled="pending !== null" @click="otherDialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!otherText.trim() || pending !== null"
        @click="submitOther"
      >提交</el-button>
    </template>
  </ElDialog>
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

  &.disabled,
  &:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .check {
    font-weight: 800;
    color: #6d28d9;
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