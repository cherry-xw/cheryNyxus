<script setup lang="ts">
/**
 * LiteView：工作台 lite 极简视图（T33 L0 壳 + T34 L1 对话流）。
 * 布局契约：docs/web/mcu-lite-workbench-ui.md §2.2；渲染规则 §4.1；分页 §4.7。
 * L2：发送/审批/停止；L3：详情抽屉（node.get）。
 */
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useLiteStore, type LeanTimelineNode, type LiteInteraction } from './liteStore'
import DetailDrawer from './DetailDrawer.vue'

const props = defineProps<{ windowId: string; presetName?: string }>()

const lite = useLiteStore()

const connectionLabel = computed(() => {
  switch (lite.connection.phase) {
    case 'idle':
      return '未连接'
    case 'connecting':
      return '连接中…'
    case 'connected':
      return '已连接'
    case 'reconnecting':
      return `重连中…（第 ${lite.connection.reconnectAttempts} 次退避）`
    case 'unsupported':
      return '版本不兼容（服务端 lite profile 版本过新，请升级）'
    default:
      return '—'
  }
})

const trafficLabel = computed(() => {
  const kb = lite.connection.receivedBytes / 1024
  return kb >= 1 ? `${kb.toFixed(1)} KB` : `${lite.connection.receivedBytes} B`
})

const hydrationLabel = computed(() => {
  switch (lite.hydration) {
    case 'idle':
      return ''
    case 'chat-list':
      return '加载会话…'
    case 'chat-open':
      return '加载时间线…'
    case 'interaction-list':
      return '加载待办…'
    case 'ready':
      return ''
    case 'failed':
      return `加载失败：${lite.hydrationError ?? '未知错误'}`
    default:
      return ''
  }
})

/** 主对话流（§4.1）：用户消息 + 最终回复；中间节点状态行穿插（按 orderKey 归并）。 */
interface StreamRow {
  key: string
  kind: 'user' | 'agent-reply' | 'process'
  node?: LeanTimelineNode
}

const streamRows = computed<StreamRow[]>(() => {
  const rows: StreamRow[] = []
  const merged = [...lite.mainStreamNodes, ...lite.processNodes].sort((a, b) => a.orderKey - b.orderKey)
  for (const node of merged) {
    if (node.actorKind === 'user') {
      rows.push({ key: node.id, kind: 'user', node })
    } else if (node.direction === 'agent-to-user') {
      rows.push({ key: node.id, kind: 'agent-reply', node })
    } else {
      rows.push({ key: node.id, kind: 'process', node })
    }
  }
  return rows
})

/** done.finalMessage 即时终态（§4.1 T31 W2 修正）：patch 权威节点未到时先行显示。 */
const liveFinalMessage = computed(() => {
  if (!lite.finalMessage) return null
  const exists = lite.leanTimeline.some(
    (n) => n.id === lite.finalMessage?.msgId && n.direction === 'agent-to-user',
  )
  return exists ? null : lite.finalMessage
})

const showRunningRow = computed(() => !!lite.runningState && !liveFinalMessage.value)

/** 状态行图标：termination code 判定（§4.1）。 */
function processIcon(node: LeanTimelineNode): string {
  const code = node.termination?.code
  if (node.status === 'revoked') return '✗'
  if (typeof code === 'string') return code === 'user_abort' || code === 'error' ? '✗' : '✓'
  return '⟳'
}

function processLabel(node: LeanTimelineNode): string {
  if (node.toolNames?.length) return node.toolNames.join(', ')
  return node.summary?.slice(0, 40) || node.kind
}

// ---- 分页（§4.7）----
const loadingOlder = ref(false)
async function loadOlder() {
  if (loadingOlder.value) return
  loadingOlder.value = true
  try {
    await lite.loadOlder()
  } finally {
    loadingOlder.value = false
  }
}

// ---- 子任务展开（§4.1 v0.2）----
const subTaskExpanded = ref(false)
const subTaskNodes = computed(() => lite.subTaskNodes)

// ---- 自动滚动（新消息到底，除非用户上滚；加载更早保持视口）----
const streamEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
function onStreamScroll() {
  const el = streamEl.value
  if (!el) return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
async function scrollToBottom() {
  if (!autoScroll.value) return
  await nextTick()
  const el = streamEl.value
  if (el) el.scrollTop = el.scrollHeight
}
onMounted(scrollToBottom)
watch(
  () => [streamRows.value.length, lite.finalMessage?.receivedAt, lite.runningState !== null],
  scrollToBottom,
)
async function loadOlderPreserve() {
  const el = streamEl.value
  const prevHeight = el?.scrollHeight ?? 0
  await loadOlder()
  await nextTick()
  if (el) el.scrollTop = el.scrollHeight - prevHeight
}

const nodeCountLabel = computed(() =>
  lite.nodeCount !== null ? `${lite.nodeCount} 节点` : `${lite.leanTimeline.length} 节点`,
)

// ---- L2：发送（§4.5）----
const inputText = ref('')
const sending = ref(false)
async function onSend() {
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

// ---- L2：待处理交互（§4.3/§4.9）----
const actionableInteractions = computed(() =>
  lite.interactions.filter((i) => ['pending', 'resolving', 'blocked'].includes(i.status)),
)
/** 审批参数键值表（截断值展示；全文留 L3 node.get）。 */
function approvalEntries(interaction: LiteInteraction): Array<[string, string]> {
  const args = interaction.payload?.arguments
  if (args && typeof args === 'object') {
    return Object.entries(args as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === 'string' ? (v.length > 60 ? v.slice(0, 60) + '…' : v) : JSON.stringify(v),
    ])
  }
  return []
}
const deciding = ref<string | null>(null)
async function onDecide(interaction: LiteInteraction, action: 'accept' | 'reject') {
  deciding.value = interaction.interactionId
  try {
    await lite.decideApproval(interaction.interactionId, action)
  } finally {
    deciding.value = null
  }
}

/** 提问渲染（§4.3 multiSelect/freeText）。 */
interface QuestionView {
  questionId: string
  question: string
  options: Array<{ label: string }>
  multiSelect: boolean
  freeText: boolean
}
function questionsOf(interaction: LiteInteraction): QuestionView[] {
  const qs = interaction.payload?.questions
  if (!Array.isArray(qs)) return []
  return (qs as Array<Record<string, unknown>>).map((q) => ({
    questionId: typeof q.questionId === 'string' ? q.questionId : '',
    question: typeof q.question === 'string' ? q.question : '',
    options: Array.isArray(q.options) ? (q.options as Array<{ label: string }>) : [],
    multiSelect: q.multiSelect === true,
    freeText: !Array.isArray(q.options) || (q.options as unknown[]).length === 0,
  }))
}
const questionDrafts = ref<Record<string, Record<string, string[] | string>>>({})
function selectedOf(batchId: string, questionId: string): string[] {
  const draft = questionDrafts.value[batchId]?.[questionId]
  return Array.isArray(draft) ? draft : []
}
function toggleOption(batchId: string, q: QuestionView, label: string) {
  const batch = { ...questionDrafts.value[batchId] }
  const current = new Set(selectedOf(batchId, q.questionId))
  if (q.multiSelect) {
    if (current.has(label)) current.delete(label)
    else current.add(label)
    batch[q.questionId] = [...current]
  } else {
    batch[q.questionId] = current.has(label) ? [] : [label]
  }
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
function textDraftOf(batchId: string, questionId: string): string {
  const draft = questionDrafts.value[batchId]?.[questionId]
  return typeof draft === 'string' ? draft : ''
}
function setTextDraft(batchId: string, questionId: string, value: string) {
  const batch = { ...questionDrafts.value[batchId] }
  batch[questionId] = value
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
const answering = ref<string | null>(null)
async function onAnswerBatch(interaction: LiteInteraction) {
  const batchId = interaction.interactionId
  const answers = questionsOf(interaction).map((q) => {
    const sel = selectedOf(batchId, q.questionId)
    const text = textDraftOf(batchId, q.questionId)
    if (q.freeText) return { questionId: q.questionId, freeText: text }
    return { questionId: q.questionId, selectedLabels: sel }
  })
  answering.value = batchId
  try {
    await lite.answerQuestion(batchId, answers)
  } finally {
    answering.value = null
  }
}

// ---- L2：停止（§4.6 B 定案）----
const aborting = ref(false)
async function onStop() {
  aborting.value = true
  try {
    await lite.abortRun()
  } finally {
    aborting.value = false
  }
}

// ---- L2：审批超时倒计时（§4.9：deadlineAt − (now+Δ)；本地提示性，终态以 interaction.changed 驱动）----
const nowTick = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  countdownTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})
function remainingLabel(interaction: LiteInteraction): string {
  void nowTick.value // 响应性锚点：每秒 tick 驱动倒计时重渲染
  if (typeof interaction.deadlineAt !== 'number') return ''
  const remaining = interaction.deadlineAt - lite.calibratedNow()
  if (remaining <= 0) return '已超时'
  const s = Math.ceil(remaining / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

// ---- L2：错误码分支（§4.10 D13 六码）----
const errorBanner = computed(() => {
  const err = lite.lastCommandError
  if (!err) return null
  switch (err.code) {
    case 'INTERACTION_STALE':
      return { text: '内容已变化，请刷新后重试', action: 'refresh' as const }
    case 'INTERACTION_ALREADY_RESOLVED':
      return { text: '已在其他视图处理', action: 'refresh' as const }
    case 'COMMAND_CONFLICT':
      return { text: '该操作正在处理中', action: null }
    case 'INPUT_QUEUE_FULL':
      return { text: '正在处理上一条，稍候', action: null }
    case 'RATE_LIMITED':
      return { text: '请求过于频繁，请稍后再试', action: null }
    case 'PROFILE_VERSION_UNSUPPORTED':
      return { text: '版本不兼容，请升级客户端', action: null }
    default:
      return { text: err.message, action: null }
  }
})
async function onErrorAction() {
  if (errorBanner.value?.action === 'refresh') {
    await lite.refreshInteractions()
    lite.lastCommandError = null
  }
}

// ---- L3：详情抽屉（§4.4）----
const detailNodeId = ref<string | null>(null)
const detailFocusToolCall = ref<string | null>(null)
function openDetail(nodeId: string) {
  detailFocusToolCall.value = null
  detailNodeId.value = nodeId
}
/** 审批查看全文（D 定案 id 映射：interactionId = sense call id = toolCall id）。 */
function openApprovalDetail(interaction: LiteInteraction) {
  detailFocusToolCall.value = interaction.interactionId
  const anchor = interaction.payload?.anchorNodeId
  if (typeof anchor === 'string') {
    detailNodeId.value = anchor
    return
  }
  // 无 anchor：在 leanTimeline 中按 call id 定位所属消息节点（toolNames 非空的最新节点）
  const node = [...lite.leanTimeline]
    .reverse()
    .find((n) => n.kind === 'message' && (n.toolNames?.length ?? 0) > 0)
  detailNodeId.value = node?.id ?? null
}
</script>

<template>
  <div class="lite-view" :data-window="props.windowId">
    <div class="lite-statusbar">
      <span class="lite-conn" :data-phase="lite.connection.phase">{{ connectionLabel }}</span>
      <span v-if="hydrationLabel" class="lite-hydration">{{ hydrationLabel }}</span>
      <span v-if="lite.runningState" class="lite-running">⟳ 运行中…</span>
      <span class="lite-session">{{ props.presetName || '会话' }}{{ lite.rootChatId ? ' · ' + lite.rootChatId.slice(0, 8) : '' }}</span>
      <span class="lite-traffic">≈ {{ trafficLabel }}</span>
    </div>

    <div ref="streamEl" class="lite-stream" aria-label="对话流" @scroll="onStreamScroll">
      <button
        v-if="lite.hasMoreOlder"
        type="button"
        class="lite-load-older"
        :disabled="loadingOlder"
        @click="loadOlderPreserve"
      >
        {{ loadingOlder ? '加载中…' : '加载更早' }}
      </button>

      <template v-for="row in streamRows" :key="row.key">
        <div v-if="row.kind === 'user'" class="lite-row lite-user">
          <span class="lite-role">[用户]</span>
          <span class="lite-text">{{ row.node?.summary }}</span>
        </div>

        <div v-else-if="row.kind === 'agent-reply'" class="lite-row lite-reply">
          <span class="lite-role">[agent]</span>
          <span class="lite-text">{{ row.node?.summary }}</span>
          <button type="button" class="lite-detail-btn" @click="openDetail(row.node!.id)">详情 &gt;</button>
        </div>

        <div
          v-else
          class="lite-row lite-process"
          role="button"
          tabindex="0"
          @click="openDetail(row.node!.id)"
          @keydown.enter="openDetail(row.node!.id)"
        >
          <span class="lite-icon">{{ processIcon(row.node!) }}</span>
          <span class="lite-text">{{ processLabel(row.node!) }}</span>
        </div>
      </template>

      <div v-if="liveFinalMessage" class="lite-row lite-reply">
        <span class="lite-role">[agent]</span>
        <span class="lite-text">{{ liveFinalMessage.content }}</span>
        <button type="button" class="lite-detail-btn" @click="openDetail(liveFinalMessage!.msgId)">详情 &gt;</button>
      </div>

      <div v-if="showRunningRow" class="lite-row lite-process">
        <span class="lite-icon">⟳</span>
        <span class="lite-text">运行中…</span>
        <button
          type="button"
          class="lite-stop-btn"
          :disabled="aborting"
          @click="onStop"
        >{{ aborting ? '停止中…' : '停止' }}</button>
      </div>

      <div v-if="subTaskNodes.length > 0" class="lite-subtask">
        <button type="button" class="lite-subtask-toggle" @click="subTaskExpanded = !subTaskExpanded">
          {{ subTaskExpanded ? '▾' : '▸' }} 子任务（{{ subTaskNodes.length }}）
        </button>
        <div v-if="subTaskExpanded" class="lite-subtask-list">
          <div
            v-for="n in subTaskNodes"
            :key="n.id"
            class="lite-row lite-subtask-row"
            :data-direction="n.direction"
          >
            <span class="lite-icon">{{ n.direction === 'child-to-parent' ? '✓' : '⟳' }}</span>
            <span class="lite-text">{{ n.summary?.slice(0, 50) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 错误条（§4.10 D13 六码分支） -->
    <div v-if="errorBanner" class="lite-error-banner" role="alert">
      <span>{{ errorBanner.text }}</span>
      <button
        v-if="errorBanner.action === 'refresh'"
        type="button"
        class="lite-error-action"
        @click="onErrorAction"
      >刷新</button>
    </div>

    <!-- 审批/提问区（§4.3/§4.9） -->
    <div v-if="actionableInteractions.length > 0" class="lite-interactions">
      <div
        v-for="interaction in actionableInteractions"
        :key="interaction.interactionId"
        class="lite-interaction"
      >
        <template v-if="interaction.kind === 'approval'">
          <div class="lite-interaction-head">
            <strong>审批：{{ interaction.payload?.senseName ?? interaction.interactionId.slice(0, 8) }}</strong>
            <span class="lite-countdown" :data-expired="remainingLabel(interaction) === '已超时'">{{ remainingLabel(interaction) }}</span>
          </div>
          <dl class="lite-args">
            <template v-for="entry in approvalEntries(interaction)" :key="entry[0]">
              <dt>{{ entry[0] }}</dt>
              <dd>{{ entry[1] }}</dd>
            </template>
          </dl>
          <button
            type="button"
            class="lite-view-full"
            :disabled="!interaction.payload?.anchorNodeId && detailNodeId === null"
            @click="openApprovalDetail(interaction)"
          >查看全文</button>
          <div class="lite-interaction-actions">
            <button
              type="button"
              class="lite-btn is-accept"
              :disabled="deciding === interaction.interactionId || remainingLabel(interaction) === '已超时'"
              @click="onDecide(interaction, 'accept')"
            >批准</button>
            <button
              type="button"
              class="lite-btn is-reject"
              :disabled="deciding === interaction.interactionId || remainingLabel(interaction) === '已超时'"
              @click="onDecide(interaction, 'reject')"
            >拒绝</button>
          </div>
        </template>

        <template v-else-if="interaction.kind === 'question'">
          <div class="lite-interaction-head">
            <strong>提问</strong>
            <span class="lite-countdown" :data-expired="remainingLabel(interaction) === '已超时'">{{ remainingLabel(interaction) }}</span>
          </div>
          <div
            v-for="q in questionsOf(interaction)"
            :key="q.questionId"
            class="lite-question"
          >
            <p class="lite-question-text">{{ q.question }}</p>
            <template v-if="!q.freeText">
              <label
                v-for="opt in q.options"
                :key="opt.label"
                class="lite-option"
              >
                <input
                  :type="q.multiSelect ? 'checkbox' : 'radio'"
                  :name="interaction.interactionId + ':' + q.questionId"
                  :checked="selectedOf(interaction.interactionId, q.questionId).includes(opt.label)"
                  @change="toggleOption(interaction.interactionId, q, opt.label)"
                >
                <span>{{ opt.label }}</span>
              </label>
            </template>
            <textarea
              v-else
              class="lite-freetext"
              rows="2"
              :value="textDraftOf(interaction.interactionId, q.questionId)"
              placeholder="输入回答"
              @input="setTextDraft(interaction.interactionId, q.questionId, ($event.target as HTMLTextAreaElement).value)"
            />
          </div>
          <div class="lite-interaction-actions">
            <button
              type="button"
              class="lite-btn is-accept"
              :disabled="answering === interaction.interactionId"
              @click="onAnswerBatch(interaction)"
            >提交回答</button>
          </div>
        </template>
      </div>
    </div>

    <!-- 输入区（§4.5：Ctrl+Enter 发送） -->
    <div class="lite-input">
      <input
        v-model="inputText"
        type="text"
        class="lite-input-box"
        placeholder="发送消息（Ctrl+Enter）"
        :disabled="sending"
        @keydown.ctrl.enter.prevent="onSend"
        @keydown.meta.enter.prevent="onSend"
      >
      <button
        type="button"
        class="lite-send-btn"
        :disabled="sending || !inputText.trim()"
        @click="onSend"
      >发送</button>
    </div>

    <div class="lite-footer">
      <span class="lite-nodecount">{{ nodeCountLabel }}</span>
      <span class="lite-actions">…</span>
    </div>

    <!-- L3：详情抽屉（§4.4） -->
    <DetailDrawer
      :node-id="detailNodeId"
      :focus-tool-call-id="detailFocusToolCall"
      @close="detailNodeId = null"
    />
  </div>
</template>

<style scoped>
.lite-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
}

.lite-statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex: none;
}

.lite-conn[data-phase='connected'] { color: var(--el-color-success); }
.lite-conn[data-phase='reconnecting'],
.lite-conn[data-phase='connecting'] { color: var(--el-color-warning); }
.lite-conn[data-phase='unsupported'] { color: var(--el-color-danger); }

.lite-traffic { margin-left: auto; }

.lite-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.lite-load-older {
  display: block;
  margin: 0 auto 10px;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: transparent;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  cursor: pointer;
}
.lite-load-older:hover:not(:disabled) { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.lite-load-older:disabled { opacity: 0.6; cursor: default; }

.lite-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  line-height: 1.5;
  word-break: break-all;
}

.lite-role { flex: none; color: var(--el-text-color-secondary); font-size: 12px; }
.lite-user .lite-text { white-space: pre-wrap; }
.lite-reply .lite-text { color: var(--el-text-color-primary); }
.lite-reply .lite-role { color: var(--el-color-primary); }

.lite-process { color: var(--el-text-color-secondary); font-size: 12px; cursor: pointer; }
.lite-process:hover { color: var(--el-text-color-primary); }

.lite-icon { flex: none; width: 14px; text-align: center; }

.lite-detail-btn,
.lite-stop-btn {
  flex: none;
  padding: 0 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
}
.lite-detail-btn:enabled:hover,
.lite-stop-btn:enabled:hover { color: var(--el-color-primary); }
.lite-stop-btn:disabled { opacity: 0.5; cursor: default; }

.lite-subtask { margin-top: 8px; border-top: 1px dashed var(--el-border-color-lighter); padding-top: 6px; }
.lite-subtask-toggle {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
}
.lite-subtask-row { font-size: 12px; color: var(--el-text-color-secondary); }

/* L2：错误条（§4.10） */
.lite-error-banner {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  border-top: 1px solid var(--el-color-danger-light-7);
}
.lite-error-action {
  padding: 0 8px;
  font-size: 12px;
  color: var(--el-color-primary);
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 4px;
  cursor: pointer;
}

/* L2：审批/提问区（§4.3） */
.lite-interactions {
  flex: none;
  max-height: 40%;
  overflow-y: auto;
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 8px 12px;
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
.lite-countdown { font-size: 12px; color: var(--el-color-warning); }
.lite-countdown[data-expired='true'] { color: var(--el-color-danger); }
.lite-args {
  display: grid;
  grid-template-columns: minmax(60px, auto) 1fr;
  gap: 2px 10px;
  margin: 6px 0;
  font-size: 12px;
}
.lite-args dt { color: var(--el-text-color-secondary); }
.lite-args dd { margin: 0; word-break: break-all; }
.lite-interaction-actions { display: flex; gap: 8px; margin-top: 6px; }
.lite-view-full {
  margin-top: 4px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--el-color-primary);
  background: transparent;
  border: none;
  cursor: pointer;
}
.lite-view-full:disabled { opacity: 0.5; cursor: default; }
.lite-btn {
  padding: 2px 14px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--el-border-color);
  background: transparent;
  cursor: pointer;
}
.lite-btn.is-accept { color: var(--el-color-success); border-color: var(--el-color-success); }
.lite-btn.is-reject { color: var(--el-color-danger); border-color: var(--el-color-danger); }
.lite-btn:disabled { opacity: 0.5; cursor: default; }
.lite-question { margin: 6px 0; }
.lite-question-text { margin: 2px 0; font-size: 12px; }
.lite-option {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
  cursor: pointer;
}
.lite-freetext {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color-blank);
  color: inherit;
  font-size: 12px;
}
.lite-send-btn {
  margin-left: 8px;
  padding: 4px 14px;
  font-size: 12px;
  color: var(--el-color-primary);
  background: transparent;
  border: 1px solid var(--el-color-primary);
  border-radius: 6px;
  cursor: pointer;
}
.lite-send-btn:disabled { opacity: 0.5; cursor: default; }
.lite-input { display: flex; align-items: center; }

.lite-input {
  flex: none;
  padding: 8px 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.lite-input-box {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
  color: inherit;
}

.lite-footer {
  flex: none;
  display: flex;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  border-top: 1px solid var(--el-border-color-lighter);
}
</style>
