<script setup lang="ts">
/**
 * LiteInteractionView：单条待处理交互（审批 / 提问）的交互区（v2026-11）。
 *
 * 原「待处理面板」迁入详情抽屉后的承载组件：点击大模型响应回来的工具按钮 icon，
 * 在侧边抽屉的工具调用卡内完成审批（允许/拒绝）与提问（单选/多选/补充/自由输入/提交）。
 * - 交互数据与草稿/提交逻辑全部来自 useLiteInteractions（rootUi.interactionDrafts 持久化草稿）；
 * - 提问批的多题分别挂在各自的工具调用卡上（questionId = callId），本组件只渲染
 *   questionId 对应的一题，并显示批次进度；提交回答按钮提交整个批次（任一卡可提交）；
 * - 交互完成后（interaction 不再命中工具卡）由 LiteToolCallDetail 自动切回只读展示。
 */
import { computed } from 'vue'
import type { InteractionRecord } from '@/application/backend/public'
import { useLiteInteractions } from './useLiteInteractions'
import ApprovalSummary from '@/features/agent/cards/ApprovalSummary.vue'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import FileChangeDiff from '@/features/agent/cards/FileChangeDiff.vue'

const props = defineProps<{
  windowId: string
  rootChatId: string
  interaction: InteractionRecord
  /** 提问批中本卡对应的问题 id（= 触发该提问的工具调用 callId）；审批交互忽略。 */
  questionId?: string
}>()

const interactions = useLiteInteractions(
  () => props.windowId,
  () => props.rootChatId,
)
// 顶层解构：模板中直接使用裸 ref（嵌套对象属性不会自动解包）。
const { connectionBlocked } = interactions

const isApproval = computed(() => props.interaction.kind === 'approval')
const errorMessage = computed(
  () => interactions.lite.interactionError(props.interaction.interactionId)?.message,
)

// ── 提问：本卡对应的一题 + 批次进度 ──────────────────────────────────
const questions = computed(() => interactions.questionsOf(props.interaction))
const question = computed(
  () =>
    questions.value.find((item) => item.questionId === props.questionId) ?? questions.value[0],
)
const questionIndex = computed(() =>
  Math.max(
    0,
    questions.value.findIndex((item) => item.questionId === question.value?.questionId),
  ),
)
const questionError = computed(() =>
  question.value
    ? interactions.lite.questionError(props.interaction.interactionId, question.value.questionId)
        ?.message
    : undefined,
)
const answeredCount = computed(() => interactions.answeredQuestionCount(props.interaction))
const canSubmit = computed(() => interactions.canAnswerBatch(props.interaction))
const submitting = computed(() => interactions.answering.value === props.interaction.interactionId)
const decidingThis = computed(() => interactions.deciding.value === props.interaction.interactionId)
const remaining = computed(() => interactions.remainingLabel(props.interaction))
const expired = computed(() => remaining.value === '已超时')
const blocked = computed(
  () => connectionBlocked.value || interactions.interactionSettled(props.interaction),
)
</script>

<template>
  <div class="lite-interaction-view" :class="isApproval ? 'is-approval' : 'is-question'">
    <!-- ── 审批 ── -->
    <template v-if="isApproval">
      <header class="lite-interaction-head">
        <span class="lite-interaction-kicker">APPROVAL REQUEST</span>
        <span class="lite-interaction-head-right">
          <span class="lite-interaction-dot" :data-status="interaction.status" aria-hidden="true" />
          <span
            v-if="interaction.status !== 'pending'"
            class="lite-status-pill"
            :data-status="interaction.status"
            >{{ interactions.interactionStatusLabel(interaction) }}</span
          >
          <span v-if="remaining" class="lite-countdown" :data-expired="expired">{{
            remaining
          }}</span>
        </span>
      </header>
      <ApprovalSummary
        class="lite-approval-overview"
        :sense-name="interaction.payload?.senseName"
        :args="interactions.approvalArguments(interaction)"
      />
      <p class="lite-risk-summary">
        <span aria-hidden="true">!</span>{{ interactions.approvalRiskSummary(interaction) }}
      </p>
      <details class="lite-technical-details">
        <summary>技术详情</summary>
        <div class="lite-technical-details-body">
          <ParsedArgs
            :args="interactions.approvalArguments(interaction)"
            title="完整操作参数"
            embedded
          />
          <FileChangeDiff :args="interactions.approvalArguments(interaction)" embedded />
        </div>
      </details>
      <p v-if="errorMessage" class="lite-object-error" role="alert">{{ errorMessage }}</p>
      <footer v-if="interactions.interactionActionable(interaction)" class="lite-interaction-actions">
        <span class="lite-action-hint">批准后将立即执行，请先核对目标与变更。</span>
        <button
          type="button"
          class="lite-btn is-reject"
          :disabled="decidingThis || expired || connectionBlocked"
          @click="interactions.onDecide(interaction, 'reject')"
        >
          拒绝
        </button>
        <button
          type="button"
          class="lite-btn is-accept"
          :disabled="decidingThis || expired || connectionBlocked"
          @click="interactions.onDecide(interaction, 'accept')"
        >
          {{ decidingThis ? '处理中…' : '允许执行' }}
        </button>
      </footer>
    </template>

    <!-- ── 提问 ── -->
    <template v-else>
      <header
        v-if="questions.length > 1"
        class="lite-interaction-head is-question-head"
      >
        <span class="lite-interaction-head-right">
          <span class="lite-interaction-dot" :data-status="interaction.status" aria-hidden="true" />
          <span>第 {{ questionIndex + 1 }}/{{ questions.length }} 题 · 已完成 {{ answeredCount }}/{{ questions.length }}</span>
        </span>
      </header>
      <div class="lite-question-workspace">
        <fieldset v-if="question" class="lite-followup-question">
          <p class="lite-question-title">{{ question.question }}</p>
          <p v-if="question.freeText || question.multiSelect" class="lite-question-type">
            {{ question.freeText ? '自由回答' : '可多选 · 再点已选项可取消' }}
          </p>
          <p v-if="questionError" class="lite-question-error" role="alert">
            {{ questionError }}
          </p>
          <template v-if="!question.freeText">
            <div class="lite-options-grid">
              <div
                v-for="option in question.options"
                :key="option.label"
                class="lite-option-card"
                :class="[
                  `is-${question.multiSelect ? 'multi' : 'single'}`,
                  {
                    'is-selected': interactions
                      .selectedOf(interaction.interactionId, question.questionId)
                      .includes(option.label),
                    'is-disabled': blocked,
                  },
                ]"
              >
                <div
                  class="lite-option-main"
                  role="option"
                  :aria-selected="interactions
                    .selectedOf(interaction.interactionId, question.questionId)
                    .includes(option.label)"
                  :aria-disabled="blocked"
                  tabindex="0"
                  @click="interactions.onToggleChoice(interaction, question, option.label)"
                  @keydown.enter.prevent="
                    interactions.onToggleChoice(interaction, question, option.label)
                  "
                  @keydown.space.prevent="
                    interactions.onToggleChoice(interaction, question, option.label)
                  "
                >
                  <span class="lite-choice-mark" aria-hidden="true">
                    {{
                      interactions
                        .selectedOf(interaction.interactionId, question.questionId)
                        .includes(option.label)
                        ? '✓'
                        : ''
                    }}
                  </span>
                  <span class="lite-option-copy">
                    <span class="lite-option-label">{{ option.label }}</span>
                    <span v-if="option.description" class="lite-option-description">{{
                      option.description
                    }}</span>
                  </span>
                  <button
                    type="button"
                    class="lite-option-note-toggle"
                    :class="{
                      'is-open': interactions.isNoteOpen(
                        interaction.interactionId,
                        question.questionId,
                        option.label,
                      ),
                    }"
                    :disabled="
                      !interactions
                        .selectedOf(interaction.interactionId, question.questionId)
                        .includes(option.label) || blocked
                    "
                    :aria-pressed="interactions.isNoteOpen(
                      interaction.interactionId,
                      question.questionId,
                      option.label,
                    )"
                    @click.stop="
                      interactions.toggleNoteOpen(
                        interaction.interactionId,
                        question.questionId,
                        option.label,
                      )
                    "
                    @keydown.stop
                  >
                    补充
                  </button>
                </div>
                <textarea
                  v-if="
                    interactions
                      .selectedOf(interaction.interactionId, question.questionId)
                      .includes(option.label) &&
                    interactions.isNoteOpen(
                      interaction.interactionId,
                      question.questionId,
                      option.label,
                    )
                  "
                  class="lite-option-note"
                  rows="2"
                  :value="interactions.noteOf(
                    interaction.interactionId,
                    question.questionId,
                    option.label,
                  )"
                  :disabled="blocked"
                  placeholder="为这个选项补充描述（可选）"
                  @input="
                    interactions.setOptionNote(
                      interaction.interactionId,
                      question.questionId,
                      option.label,
                      ($event.target as HTMLTextAreaElement).value,
                    )
                  "
                />
              </div>
              <div
                class="lite-option-card is-other"
                :class="[
                  `is-${question.multiSelect ? 'multi' : 'single'}`,
                  {
                    'is-selected': interactions.otherActiveOf(
                      interaction.interactionId,
                      question.questionId,
                    ),
                    'is-disabled': blocked,
                  },
                ]"
              >
                <div
                  class="lite-option-main"
                  role="option"
                  :aria-selected="interactions.otherActiveOf(
                    interaction.interactionId,
                    question.questionId,
                  )"
                  :aria-disabled="blocked"
                  tabindex="0"
                  @click="interactions.onToggleOther(interaction, question)"
                  @keydown.enter.prevent="interactions.onToggleOther(interaction, question)"
                  @keydown.space.prevent="interactions.onToggleOther(interaction, question)"
                >
                  <span class="lite-choice-mark" aria-hidden="true">
                    {{
                      interactions.otherActiveOf(
                        interaction.interactionId,
                        question.questionId,
                      )
                        ? '✓'
                        : ''
                    }}
                  </span>
                  <input
                    class="lite-option-other-input"
                    :value="interactions.textDraftOf(
                      interaction.interactionId,
                      question.questionId,
                    )"
                    :disabled="blocked"
                    placeholder="其他补充（可选）"
                    @click.stop
                    @keydown.stop
                    @input="
                      interactions.onOtherInput(
                        interaction,
                        question,
                        ($event.target as HTMLInputElement).value,
                      )
                    "
                  />
                </div>
              </div>
            </div>
          </template>
          <textarea
            v-else
            class="lite-freetext"
            rows="4"
            :value="interactions.textDraftOf(interaction.interactionId, question.questionId)"
            :disabled="blocked"
            placeholder="输入回答"
            @input="
              interactions.onOtherInput(
                interaction,
                question,
                ($event.target as HTMLTextAreaElement).value,
              )
            "
          />
        </fieldset>
      </div>
      <p v-if="errorMessage" class="lite-object-error" role="alert">{{ errorMessage }}</p>
      <footer
        v-if="interactions.interactionActionable(interaction)"
        class="lite-interaction-actions is-question"
      >
        <span class="lite-action-hint" v-if="questions.length > 1 && !canSubmit"
          >请完成批次内全部问题（可分别在对应工具卡中作答）</span
        >
        <span class="lite-action-hint" v-else-if="!canSubmit">请先作答本题</span>
        <button
          type="button"
          class="lite-btn is-submit"
          :disabled="submitting || connectionBlocked || !canSubmit"
          @click="interactions.onAnswerBatch(interaction)"
        >
          {{ submitting ? '提交中…' : canSubmit ? '提交回答' : '请完成全部问题' }}
        </button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
/* 交互区（审批/提问）：渲染在详情抽屉的工具调用卡内，不再自带面板底色（卡片已有）。 */
.lite-interaction-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.lite-interaction-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lite-interaction-head.is-question-head {
  justify-content: flex-end;
}
.lite-interaction-kicker {
  color: var(--el-text-color-secondary);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  letter-spacing: 0.12em;
}
.lite-interaction-head-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.lite-interaction-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}
.lite-interaction-dot[data-status='pending'] {
  background: var(--lite-tone-tool);
  animation: lite-pulse 1.4s ease-in-out infinite;
}
.lite-interaction-dot[data-status='resolving'] {
  background: var(--el-color-primary);
  animation: lite-pulse 1.2s ease-in-out infinite;
}
.lite-interaction-dot[data-status='blocked'],
.lite-interaction-dot[data-status='expired'] {
  background: var(--el-color-danger);
}
.lite-interaction-dot[data-status='completed'] {
  background: var(--el-color-success);
}
.lite-status-pill {
  padding: 0 7px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  color: var(--el-text-color-secondary);
  font-size: 12.5px;
  line-height: 16px;
}
.lite-status-pill[data-status='resolving'] {
  border-color: color-mix(in srgb, var(--el-color-warning) 55%, var(--el-border-color));
  color: var(--el-color-warning);
}
.lite-status-pill[data-status='blocked'] {
  border-color: color-mix(in srgb, var(--el-color-danger) 55%, var(--el-border-color));
  color: var(--el-color-danger);
}
.lite-countdown {
  color: var(--el-color-warning);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.lite-countdown[data-expired='true'] {
  color: var(--el-color-danger);
}

/* ── 审批：概览 / 风险 / 技术详情 ── */
.lite-approval-overview :deep(h3),
.lite-approval-overview :deep(p) {
  margin: 0;
}
.lite-risk-summary {
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border-left: 3px solid var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 8%, transparent);
  color: var(--el-text-color-regular);
  font-size: 14px;
  line-height: 1.5;
}
.lite-risk-summary > span {
  color: var(--el-color-warning);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.lite-technical-details {
  border-top: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.lite-technical-details > summary {
  padding: 8px 2px;
  color: var(--el-text-color-regular);
  cursor: pointer;
}
.lite-technical-details-body {
  display: grid;
  gap: 10px;
  padding: 2px 0 10px 16px;
}
.lite-technical-details :deep(.args-body) {
  padding-left: 0;
}
.lite-technical-details :deep(.file-diff) {
  margin: 0;
}

/* ── 操作栏 / 按钮 ── */
.lite-interaction-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.lite-action-hint {
  margin-right: auto;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.lite-btn {
  min-width: 84px;
  padding: 6px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  cursor: pointer;
  transition:
    transform 120ms ease,
    background-color 120ms ease,
    border-color 120ms ease;
}
.lite-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}
.lite-btn.is-accept {
  border-color: var(--el-color-success);
  background: var(--el-color-success);
  color: #fff;
}
.lite-btn.is-reject {
  border-color: var(--el-color-danger);
  color: var(--el-color-danger);
}
.lite-btn.is-submit {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary);
  color: #fff;
}
.lite-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

/* ── 提问：题干 / 选项卡 ── */
.lite-question-workspace {
  display: block;
  min-width: 0;
}
.lite-followup-question {
  min-width: 0;
  margin: 0;
  padding: 8px 10px;
  border: none;
  background: transparent;
}
.lite-question-title {
  margin: 0 0 6px;
  color: var(--el-text-color-primary);
  font-size: 16px;
  line-height: 1.55;
}
.lite-question-type {
  margin: 0 0 6px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  letter-spacing: 0.05em;
}
.lite-object-error,
.lite-question-error {
  margin: 4px 0;
  color: var(--el-color-danger);
  font-size: 14px;
}
.lite-options-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 6px;
}
.lite-option-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: color-mix(in srgb, var(--violet) 9%, var(--surface));
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}
.lite-option-card.is-selected {
  border-color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 8%, var(--el-bg-color));
}
.lite-option-card.is-disabled {
  opacity: 0.55;
}
.lite-option-main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  cursor: pointer;
}
.lite-option-main[aria-disabled='true'] {
  cursor: default;
}
.lite-choice-mark {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid var(--el-border-color-darker);
  color: transparent;
  font-size: 12px;
  line-height: 1;
}
.lite-option-card.is-single .lite-choice-mark {
  border-radius: 50%;
}
.lite-option-card.is-selected .lite-choice-mark {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary);
  color: #fff;
}
.lite-option-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.lite-option-label {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-size: 14px;
  line-height: 1.3;
  word-break: break-word;
}
.lite-option-description {
  min-width: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.35;
}
.lite-option-note-toggle {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition:
    color 120ms ease,
    border-color 120ms ease;
}
.lite-option-note-toggle:not(:disabled):hover {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}
.lite-option-note-toggle.is-open {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.lite-option-note-toggle:disabled {
  cursor: default;
  opacity: 0.45;
}
.lite-option-note {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: var(--el-fill-color-blank);
  color: inherit;
  resize: vertical;
}
.lite-option-other-input {
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: var(--el-fill-color-blank);
  color: inherit;
  font-size: 14px;
}
.lite-freetext {
  width: 100%;
  box-sizing: border-box;
  min-height: 92px;
  margin-top: 0;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: var(--el-fill-color-blank);
  color: inherit;
}

@keyframes lite-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

@media (max-width: 760px) {
  .lite-options-grid {
    grid-template-columns: 1fr;
  }
  .lite-action-hint {
    display: none;
  }
}
</style>
