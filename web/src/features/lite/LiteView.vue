<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLiteStore } from './liteStore'
import { useLiteCanonicalView, type LiteInteraction } from './useLiteCanonicalView'
import {
  createLiteExecutionClock,
  formatElapsed,
  projectLiteExecution,
  type LiteExecutionStepView,
} from './executionMonitor'
import type { LiteDetailSectionName } from './detailSections'
import DetailDrawer from './DetailDrawer.vue'

const props = defineProps<{ windowId: string; rootChatId: string; presetName?: string }>()

const liteUi = useLiteStore()
const lite = useLiteCanonicalView(
  () => props.windowId,
  () => props.rootChatId,
)
watch(
  () => [props.windowId, props.rootChatId] as const,
  ([windowId, rootChatId]) => liteUi.ensureRootUi(windowId, rootChatId),
  { immediate: true },
)
const rootUi = computed(() => liteUi.ensureRootUi(props.windowId, props.rootChatId))

const clock = createLiteExecutionClock()
onMounted(clock.start)
onBeforeUnmount(clock.stop)
const monitor = computed(() => projectLiteExecution(lite.execution, clock.now.value))

const connectionLabel = computed(() => {
  switch (lite.connection.phase) {
    case 'idle':
      return '未连接'
    case 'connecting':
      return '连接中…'
    case 'connected':
      return '已连接'
    case 'reconnecting':
      return '重连中…'
    default:
      return '未知'
  }
})

const hydrationLabel = computed(() => {
  if (lite.hydration === 'chat-open') return '加载执行记录…'
  if (lite.hydration === 'failed') return `加载失败：${lite.hydrationError ?? '未知错误'}`
  return ''
})

function stepStatusLabel(status: LiteExecutionStepView['status']): string {
  switch (status) {
    case 'running':
      return '执行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'rejected':
      return '已拒绝'
    case 'cancelled':
      return '已取消'
  }
}

function stepIcon(status: LiteExecutionStepView['status']): string {
  switch (status) {
    case 'running':
      return '●'
    case 'completed':
      return '✓'
    case 'failed':
      return '×'
    case 'rejected':
      return '⊘'
    case 'cancelled':
      return '–'
  }
}

function stepDetailNodeId(step: LiteExecutionStepView): string | null {
  return step.kind === 'tool'
    ? lite.detailNodeIdForToolCall(step.id)
    : lite.detailNodeIdForMessage(step.id)
}

const monitorEl = ref<HTMLElement | null>(null)
const autoScroll = computed({
  get: () => rootUi.value.autoScroll,
  set: (value: boolean) =>
    liteUi.patchRootUi(props.windowId, props.rootChatId, { autoScroll: value }),
})
function onMonitorScroll(): void {
  const element = monitorEl.value
  if (!element) return
  autoScroll.value = element.scrollHeight - element.scrollTop - element.clientHeight < 40
  liteUi.patchRootUi(props.windowId, props.rootChatId, { scrollTop: element.scrollTop })
}
async function scrollToBottom(): Promise<void> {
  if (!autoScroll.value) return
  await nextTick()
  if (monitorEl.value) monitorEl.value.scrollTop = monitorEl.value.scrollHeight
}
onMounted(async () => {
  await nextTick()
  if (!monitorEl.value) return
  if (rootUi.value.autoScroll) await scrollToBottom()
  else monitorEl.value.scrollTop = rootUi.value.scrollTop
})
watch(
  () => [
    monitor.value.steps.length,
    monitor.value.activeSteps.length,
    monitor.value.finalResponseId,
  ],
  scrollToBottom,
)

const inputText = computed({
  get: () => rootUi.value.inputDraft,
  set: (value: string) =>
    liteUi.patchRootUi(props.windowId, props.rootChatId, { inputDraft: value }),
})
const sending = ref(false)
async function onSend(): Promise<void> {
  const content = inputText.value.trim()
  if (!content || sending.value) return
  sending.value = true
  try {
    await lite.submitInput(content)
    if (!lite.lastCommandError) inputText.value = ''
  } finally {
    sending.value = false
  }
}

const actionableInteractions = computed(() =>
  lite.interactions.filter((interaction) =>
    ['pending', 'resolving', 'blocked'].includes(interaction.status),
  ),
)

function approvalRiskSummary(interaction: LiteInteraction): string {
  const security = interaction.payload.security
  if (security && typeof security === 'object') {
    const findings = (security as { findings?: unknown }).findings
    if (Array.isArray(findings)) {
      const message = (findings[0] as { message?: unknown } | undefined)?.message
      if (typeof message === 'string' && message.trim()) return message.slice(0, 120)
    }
  }
  const description = interaction.payload.senseDescription
  return typeof description === 'string' && description.trim()
    ? description.slice(0, 120)
    : '此工具需要确认后执行。'
}

const deciding = ref<string | null>(null)
async function onDecide(interaction: LiteInteraction, action: 'accept' | 'reject'): Promise<void> {
  deciding.value = interaction.interactionId
  try {
    await lite.decideApproval(interaction.interactionId, action)
  } finally {
    deciding.value = null
  }
}

interface QuestionView {
  questionId: string
  question: string
  options: Array<{ label: string }>
  multiSelect: boolean
  freeText: boolean
}
function questionsOf(interaction: LiteInteraction): QuestionView[] {
  const questions = interaction.payload.questions
  if (!Array.isArray(questions)) return []
  return (questions as Array<Record<string, unknown>>).map((question) => ({
    questionId: typeof question.questionId === 'string' ? question.questionId : '',
    question: typeof question.question === 'string' ? question.question : '',
    options: Array.isArray(question.options) ? (question.options as Array<{ label: string }>) : [],
    multiSelect: question.multiSelect === true,
    freeText: !Array.isArray(question.options) || question.options.length === 0,
  }))
}
const questionDrafts = computed({
  get: () => rootUi.value.interactionDrafts,
  set: (value: Record<string, Record<string, string[] | string>>) =>
    liteUi.patchRootUi(props.windowId, props.rootChatId, { interactionDrafts: value }),
})
function selectedOf(batchId: string, questionId: string): string[] {
  const draft = questionDrafts.value[batchId]?.[questionId]
  return Array.isArray(draft) ? draft : []
}
function toggleOption(batchId: string, question: QuestionView, label: string): void {
  const batch = { ...questionDrafts.value[batchId] }
  const current = new Set(selectedOf(batchId, question.questionId))
  if (question.multiSelect) {
    if (current.has(label)) current.delete(label)
    else current.add(label)
    batch[question.questionId] = [...current]
  } else {
    batch[question.questionId] = current.has(label) ? [] : [label]
  }
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
function textDraftOf(batchId: string, questionId: string): string {
  const draft = questionDrafts.value[batchId]?.[questionId]
  return typeof draft === 'string' ? draft : ''
}
function setTextDraft(batchId: string, questionId: string, value: string): void {
  const batch = { ...questionDrafts.value[batchId], [questionId]: value }
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
const answering = ref<string | null>(null)
async function onAnswerBatch(interaction: LiteInteraction): Promise<void> {
  const batchId = interaction.interactionId
  const answers = questionsOf(interaction).map((question) => {
    if (question.freeText) {
      return {
        questionId: question.questionId,
        freeText: textDraftOf(batchId, question.questionId),
      }
    }
    return {
      questionId: question.questionId,
      selectedLabels: selectedOf(batchId, question.questionId),
    }
  })
  answering.value = batchId
  try {
    await lite.answerQuestion(batchId, answers)
  } finally {
    answering.value = null
  }
}

const aborting = ref(false)
async function onStop(): Promise<void> {
  aborting.value = true
  try {
    await lite.abortRun()
  } finally {
    aborting.value = false
  }
}
const resuming = ref(false)
async function onResume(): Promise<void> {
  resuming.value = true
  try {
    await lite.resumeRun()
  } finally {
    resuming.value = false
  }
}
const connectionBlocked = computed(() => lite.connection.phase !== 'connected')

function remainingLabel(interaction: LiteInteraction): string {
  void clock.now.value
  if (typeof interaction.deadlineAt !== 'number') return ''
  const remaining = interaction.deadlineAt - lite.calibratedNow()
  if (remaining <= 0) return '已超时'
  const seconds = Math.ceil(remaining / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`
}

const errorBanner = computed(() => {
  const error = lite.lastCommandError
  if (!error) return null
  switch (error.code) {
    case 'INTERACTION_STALE':
      return { text: '内容已变化，请刷新后重试', action: 'refresh' as const }
    case 'INTERACTION_ALREADY_RESOLVED':
      return { text: '已在其他视图处理', action: 'refresh' as const }
    case 'COMMAND_CONFLICT':
      return { text: '该操作正在处理中', action: null }
    case 'INPUT_QUEUE_FULL':
      return { text: '正在处理上一条，请稍候', action: null }
    case 'RATE_LIMITED':
      return { text: '请求过于频繁，请稍后再试', action: null }
    case 'PROFILE_VERSION_UNSUPPORTED':
      return { text: '版本不兼容，请升级客户端', action: null }
    default:
      return { text: error.message, action: null }
  }
})
async function onErrorAction(): Promise<void> {
  if (errorBanner.value?.action !== 'refresh') return
  await lite.refreshInteractions()
  lite.lastCommandError = null
}

const detailReturnFocus = ref<HTMLElement | null>(null)
function rememberDetailTrigger(event?: Event): void {
  detailReturnFocus.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
}
function showDetail(
  nodeId: string,
  section: LiteDetailSectionName | null,
  focusToolCallId: string | null,
  event?: Event,
): void {
  rememberDetailTrigger(event)
  liteUi.patchRootUi(props.windowId, props.rootChatId, {
    detailNodeId: nodeId,
    detailInitialSection: section,
    detailFocusToolCallId: focusToolCallId,
  })
}
function openStepDetail(step: LiteExecutionStepView, event: Event): void {
  const nodeId = stepDetailNodeId(step)
  if (!nodeId) return
  showDetail(
    nodeId,
    step.kind === 'tool' ? 'toolCalls' : null,
    step.kind === 'tool' ? step.id : null,
    event,
  )
}
function openFinalDetail(event: Event): void {
  const nodeId = lite.finalMessage?.nodeId
  if (nodeId) {
    showDetail(nodeId, monitor.value.finalHasMore ? 'content' : null, null, event)
  }
}
function approvalDetailNodeId(interaction: LiteInteraction): string | null {
  const payloadAnchor = interaction.payload.anchorNodeId
  const toolOwner = lite.detailNodeIdForToolCall(interaction.interactionId)
  if (toolOwner) return toolOwner
  if (interaction.anchorNodeId) {
    const anchored = lite.detailNodeIdForMessage(interaction.anchorNodeId)
    if (anchored) return anchored
  }
  return typeof payloadAnchor === 'string' ? lite.detailNodeIdForMessage(payloadAnchor) : null
}
function openApprovalDetail(interaction: LiteInteraction, event: Event): void {
  const nodeId = approvalDetailNodeId(interaction)
  if (nodeId) showDetail(nodeId, 'toolCalls', interaction.interactionId, event)
}
async function closeDetail(): Promise<void> {
  liteUi.patchRootUi(props.windowId, props.rootChatId, {
    detailNodeId: null,
    detailInitialSection: null,
    detailFocusToolCallId: null,
  })
  await nextTick()
  detailReturnFocus.value?.focus()
  detailReturnFocus.value = null
}
</script>

<template>
  <div class="lite-view" :data-window="props.windowId">
    <div class="lite-statusbar">
      <span class="lite-conn" :data-phase="lite.connection.phase">{{ connectionLabel }}</span>
      <span v-if="hydrationLabel" class="lite-hydration">{{ hydrationLabel }}</span>
      <span class="lite-session">{{ props.presetName || '会话' }}</span>
    </div>

    <main ref="monitorEl" class="lite-monitor" aria-label="执行监控" @scroll="onMonitorScroll">
      <section class="lite-question-card" :data-status="monitor.status">
        <div class="lite-question-label">当前问题</div>
        <h2>{{ monitor.question || '等待输入问题' }}</h2>
        <div class="lite-question-meta">
          <span class="lite-root-status">{{ monitor.statusLabel }}</span>
          <time aria-label="总耗时">总计 {{ formatElapsed(monitor.elapsedMs) }}</time>
          <button
            v-if="lite.runningState"
            type="button"
            class="lite-inline-action"
            :disabled="aborting || connectionBlocked"
            @click="onStop"
          >
            {{ aborting ? '停止中…' : '停止' }}
          </button>
          <button
            v-else-if="lite.canResume"
            type="button"
            class="lite-inline-action"
            :disabled="resuming || connectionBlocked"
            @click="onResume"
          >
            {{ resuming ? '继续中…' : '继续' }}
          </button>
        </div>
      </section>

      <section class="lite-execution" aria-labelledby="lite-execution-title">
        <div class="lite-section-title">
          <h3 id="lite-execution-title">执行节点</h3>
          <span v-if="monitor.activeSteps.length">{{ monitor.activeSteps.length }} 个正在执行</span>
        </div>
        <ol v-if="monitor.steps.length" class="lite-step-list">
          <li
            v-for="step in monitor.steps"
            :key="step.key"
            class="lite-step"
            :class="{ 'is-active': step.active }"
            :data-kind="step.kind"
            :data-status="step.status"
          >
            <div class="lite-step-summary">
              <span class="lite-step-icon" aria-hidden="true">{{ stepIcon(step.status) }}</span>
              <span class="lite-step-agent">{{ step.agentLabel }}</span>
              <strong>{{ step.kind === 'tool' ? step.name : '模型响应' }}</strong>
              <span class="lite-step-status">{{ stepStatusLabel(step.status) }}</span>
              <time :aria-label="`${step.name} 耗时`">{{ formatElapsed(step.elapsedMs) }}</time>
              <button
                v-if="stepDetailNodeId(step)"
                type="button"
                class="lite-step-detail"
                @click="openStepDetail(step, $event)"
              >
                详情
              </button>
            </div>
            <div v-if="step.expanded" class="lite-step-active" aria-live="polite">
              <span class="lite-pulse" aria-hidden="true" />
              {{ step.kind === 'tool' ? `正在执行 ${step.name}` : '正在生成响应' }}
            </div>
          </li>
        </ol>
        <p v-else class="lite-empty">尚无执行节点</p>
      </section>

      <section v-if="monitor.finalPreview" class="lite-final" aria-labelledby="lite-final-title">
        <div class="lite-section-title">
          <h3 id="lite-final-title">最终结果</h3>
        </div>
        <p>{{ monitor.finalPreview }}</p>
        <button
          v-if="lite.finalMessage?.nodeId"
          type="button"
          class="lite-load-result"
          @click="openFinalDetail"
        >
          {{ monitor.finalHasMore ? '加载更多' : '查看详情' }}
        </button>
      </section>
    </main>

    <div v-if="errorBanner" class="lite-error-banner" role="alert">
      <span>{{ errorBanner.text }}</span>
      <button
        v-if="errorBanner.action === 'refresh'"
        type="button"
        class="lite-error-action"
        @click="onErrorAction"
      >
        刷新
      </button>
    </div>

    <div v-if="actionableInteractions.length" class="lite-interactions">
      <div
        v-for="interaction in actionableInteractions"
        :key="interaction.interactionId"
        class="lite-interaction"
      >
        <template v-if="interaction.kind === 'approval'">
          <div class="lite-interaction-head">
            <strong
              >审批：{{
                interaction.payload.senseName ?? interaction.interactionId.slice(0, 8)
              }}</strong
            >
            <span class="lite-countdown" :data-expired="remainingLabel(interaction) === '已超时'">
              {{ remainingLabel(interaction) }}
            </span>
          </div>
          <p class="lite-risk-summary">{{ approvalRiskSummary(interaction) }}</p>
          <button
            type="button"
            class="lite-view-full"
            :disabled="!approvalDetailNodeId(interaction)"
            @click="openApprovalDetail(interaction, $event)"
          >
            查看工具详情
          </button>
          <div class="lite-interaction-actions">
            <button
              type="button"
              class="lite-btn is-accept"
              :disabled="
                deciding === interaction.interactionId ||
                remainingLabel(interaction) === '已超时' ||
                connectionBlocked
              "
              @click="onDecide(interaction, 'accept')"
            >
              批准
            </button>
            <button
              type="button"
              class="lite-btn is-reject"
              :disabled="
                deciding === interaction.interactionId ||
                remainingLabel(interaction) === '已超时' ||
                connectionBlocked
              "
              @click="onDecide(interaction, 'reject')"
            >
              拒绝
            </button>
          </div>
        </template>

        <template v-else-if="interaction.kind === 'question_batch'">
          <div class="lite-interaction-head">
            <strong>提问</strong>
            <span class="lite-countdown" :data-expired="remainingLabel(interaction) === '已超时'">
              {{ remainingLabel(interaction) }}
            </span>
          </div>
          <div
            v-for="question in questionsOf(interaction)"
            :key="question.questionId"
            class="lite-followup-question"
          >
            <p>{{ question.question }}</p>
            <template v-if="!question.freeText">
              <label v-for="option in question.options" :key="option.label" class="lite-option">
                <input
                  :type="question.multiSelect ? 'checkbox' : 'radio'"
                  :name="interaction.interactionId + ':' + question.questionId"
                  :checked="
                    selectedOf(interaction.interactionId, question.questionId).includes(
                      option.label,
                    )
                  "
                  @change="toggleOption(interaction.interactionId, question, option.label)"
                />
                <span>{{ option.label }}</span>
              </label>
            </template>
            <textarea
              v-else
              class="lite-freetext"
              rows="2"
              :value="textDraftOf(interaction.interactionId, question.questionId)"
              placeholder="输入回答"
              @input="
                setTextDraft(
                  interaction.interactionId,
                  question.questionId,
                  ($event.target as HTMLTextAreaElement).value,
                )
              "
            />
          </div>
          <div class="lite-interaction-actions">
            <button
              type="button"
              class="lite-btn is-accept"
              :disabled="answering === interaction.interactionId || connectionBlocked"
              @click="onAnswerBatch(interaction)"
            >
              提交回答
            </button>
          </div>
        </template>
      </div>
    </div>

    <div class="lite-input">
      <input
        v-model="inputText"
        type="text"
        class="lite-input-box"
        :placeholder="connectionBlocked ? '重连中…' : '发送消息（Ctrl+Enter）'"
        :disabled="sending || connectionBlocked"
        @keydown.ctrl.enter.prevent="onSend"
        @keydown.meta.enter.prevent="onSend"
      />
      <button
        type="button"
        class="lite-send-btn"
        :disabled="sending || !inputText.trim() || connectionBlocked"
        @click="onSend"
      >
        发送
      </button>
    </div>

    <DetailDrawer
      :window-id="windowId"
      :root-chat-id="rootChatId"
      :node-id="rootUi.detailNodeId"
      :focus-tool-call-id="rootUi.detailFocusToolCallId"
      :initial-section="rootUi.detailInitialSection"
      @close="closeDetail"
    />
  </div>
</template>

<style scoped>
.lite-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-size: 13px;
}

.lite-statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.lite-session {
  margin-left: auto;
}
.lite-conn[data-phase='connected'] {
  color: var(--el-color-success);
}
.lite-conn[data-phase='connecting'],
.lite-conn[data-phase='reconnecting'] {
  color: var(--el-color-warning);
}

.lite-monitor {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}

.lite-question-card,
.lite-execution,
.lite-final {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color-overlay);
}
.lite-question-card {
  padding: 14px;
}
.lite-question-label {
  color: var(--el-color-primary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.lite-question-card h2 {
  margin: 7px 0 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 16px;
  line-height: 1.5;
}
.lite-question-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}
.lite-question-meta time {
  font-variant-numeric: tabular-nums;
}
.lite-root-status {
  color: var(--el-text-color-secondary);
}
.lite-inline-action,
.lite-load-result,
.lite-step-detail,
.lite-view-full {
  border: 0;
  background: transparent;
  color: var(--el-color-primary);
  cursor: pointer;
  font-size: 12px;
}
.lite-inline-action {
  margin-left: auto;
}
.lite-inline-action:disabled,
.lite-view-full:disabled {
  cursor: default;
  opacity: 0.5;
}

.lite-execution,
.lite-final {
  margin-top: 12px;
  padding: 12px;
}
.lite-section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.lite-section-title h3 {
  margin: 0;
  font-size: 13px;
}
.lite-section-title span {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.lite-step-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
}
.lite-step {
  margin-top: 5px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 7px;
  color: var(--el-text-color-secondary);
}
.lite-step.is-active {
  border-color: color-mix(in srgb, var(--el-color-primary) 45%, var(--el-border-color));
  color: var(--el-text-color-primary);
}
.lite-step[data-status='failed'] {
  border-color: var(--el-color-danger-light-5);
}
.lite-step[data-status='rejected'],
.lite-step[data-status='cancelled'] {
  opacity: 0.78;
}
.lite-step-summary {
  min-height: 30px;
  display: grid;
  grid-template-columns: 18px minmax(62px, auto) minmax(80px, 1fr) auto auto auto;
  align-items: center;
  gap: 7px;
  padding: 3px 8px;
}
.lite-step-summary time {
  font-variant-numeric: tabular-nums;
}
.lite-step-icon {
  text-align: center;
}
.lite-step-agent,
.lite-step-status {
  font-size: 11px;
}
.lite-step-summary strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lite-step-active {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
  background: var(--el-fill-color-lighter);
}
.lite-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-color-primary);
  animation: lite-pulse 1.2s ease-in-out infinite;
}
@keyframes lite-pulse {
  50% {
    opacity: 0.35;
    transform: scale(0.8);
  }
}
@media (prefers-reduced-motion: reduce) {
  .lite-pulse {
    animation: none;
  }
}
.lite-empty {
  margin: 12px 0 2px;
  color: var(--el-text-color-placeholder);
}
.lite-final p {
  margin: 9px 0 5px;
  white-space: pre-wrap;
  line-height: 1.6;
}
.lite-load-result {
  padding: 3px 0;
}

.lite-error-banner {
  flex: none;
  display: flex;
  gap: 8px;
  padding: 5px 12px;
  border-top: 1px solid var(--el-color-danger-light-7);
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}
.lite-error-action {
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.lite-interactions {
  flex: none;
  max-height: 40%;
  overflow-y: auto;
  padding: 8px 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.lite-interaction {
  padding: 6px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}
.lite-interaction-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lite-countdown {
  color: var(--el-color-warning);
  font-size: 12px;
}
.lite-countdown[data-expired='true'] {
  color: var(--el-color-danger);
}
.lite-risk-summary {
  margin: 5px 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.lite-interaction-actions {
  display: flex;
  gap: 8px;
  margin-top: 7px;
}
.lite-btn {
  padding: 2px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
.lite-btn.is-accept {
  border-color: var(--el-color-success);
  color: var(--el-color-success);
}
.lite-btn.is-reject {
  border-color: var(--el-color-danger);
  color: var(--el-color-danger);
}
.lite-btn:disabled {
  cursor: default;
  opacity: 0.5;
}
.lite-followup-question {
  margin: 7px 0;
}
.lite-followup-question p {
  margin: 2px 0;
}
.lite-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  cursor: pointer;
}
.lite-freetext {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 5px;
  background: var(--el-fill-color-blank);
  color: inherit;
}

.lite-input {
  flex: none;
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.lite-input-box {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
  color: inherit;
}
.lite-send-btn {
  margin-left: 8px;
  padding: 5px 14px;
  border: 1px solid var(--el-color-primary);
  border-radius: 6px;
  background: transparent;
  color: var(--el-color-primary);
  cursor: pointer;
}
.lite-send-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

@media (max-width: 560px) {
  .lite-step-summary {
    grid-template-columns: 18px 1fr auto;
  }
  .lite-step-agent,
  .lite-step-status,
  .lite-step-detail {
    grid-row: 2;
  }
  .lite-inline-action {
    margin-left: 0;
  }
}
</style>
