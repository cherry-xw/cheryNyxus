<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useLiteStore, type LiteQuestionDraft } from './liteStore'
import { useLiteCanonicalView, type LiteInteraction } from './useLiteCanonicalView'
import {
  createLiteExecutionClock,
  formatElapsed,
  projectLiteExecution,
  projectLiteHistory,
  toolTypeEmoji,
  type LiteRunNode,
  type LiteRunNodeStatus,
  type LiteRunRow,
} from './executionMonitor'
import type { LiteDetailSectionName } from './detailSections'
import LiteScrollbar from './LiteScrollbar.vue'
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
onMounted(() => {
  clock.start()
  void lite.loadSenseTools()
})
onBeforeUnmount(clock.stop)
const monitor = computed(() => projectLiteExecution(lite.execution, clock.now.value))
/** 运行历史：从开始节点往下，用户问题 / 工具运行 / 大模型响应 关键节点（需求 1c），工具名走中文（sense.tools）。 */
const history = computed(() =>
  projectLiteHistory(lite.runNodes, lite.execution, clock.now.value, lite.toolMeta),
)

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

/** 轻量状态 + 节点数（需求 2：窗体顶部去掉「已连接」，改为轻量状态/节点数展示）。 */
const liteStatus = computed(() => {
  if (lite.hydration === 'chat-open') return { text: '加载执行记录…', tone: 'busy' as const }
  if (lite.hydration === 'failed') return { text: '加载失败', tone: 'danger' as const }
  if (history.value.running) return { text: '运行中', tone: 'busy' as const }
  if (lite.connection.phase === 'reconnecting') return { text: '重连中…', tone: 'busy' as const }
  if (lite.connection.phase === 'connected') return { text: '空闲', tone: 'ok' as const }
  return { text: connectionLabel.value, tone: 'muted' as const }
})

function runStatusLabel(status: LiteRunNodeStatus): string {
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
    history.value.nodes.length,
    history.value.nodes.filter((node) => node.active).length,
    history.value.running,
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
    const sent = await lite.submitInput(content)
    if (sent) inputText.value = ''
  } finally {
    sending.value = false
  }
}

/**
 * 回车发送（需求：普通 Enter 直接发送；保留 Ctrl/Cmd+Enter；单行 input 无换行语义，
 * shift+Enter 同样发送；中文输入法组合确认（isComposing / keyCode 229）时不触发，避免误发）。
 */
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void onSend()
}

function interactionStatusLabel(interaction: LiteInteraction): string {
  return {
    pending: '待处理',
    resolving: '处理中',
    blocked: '恢复失败，可重试',
    completed: '已处理',
    expired: '已超时，未执行',
    cancelled: '已取消',
  }[interaction.status]
}

function interactionActionable(interaction: LiteInteraction): boolean {
  return (
    interaction.status === 'pending' ||
    (interaction.kind === 'approval' && interaction.status === 'blocked')
  )
}

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

// ── 顶部待操作 tab 栏（需求 1a/1b/4e）：只渲染存在的类型，每个审批/提问交互独立一个小 Tab，
// 按时间排序；激活的交互在 Tab 栏下方的内容面板展示。
const actionableInteractions = computed(() => lite.interactions.filter(interactionActionable))
const sortedInteractions = computed(() =>
  [...actionableInteractions.value].sort(
    (a, b) => a.createdAt - b.createdAt || a.interactionId.localeCompare(b.interactionId),
  ),
)

interface PendingTabView {
  id: string
  kind: 'approval' | 'question'
  label: string
  countdown: string
  expired: boolean
}
const pendingTabs = computed<PendingTabView[]>(() =>
  sortedInteractions.value.map((interaction) => {
    if (interaction.kind === 'approval') {
      const senseName =
        typeof interaction.payload.senseName === 'string' && interaction.payload.senseName.trim()
          ? interaction.payload.senseName
          : '审批'
      return {
        id: interaction.interactionId,
        kind: 'approval' as const,
        label: senseName.length > 12 ? senseName.slice(0, 12) + '…' : senseName,
        countdown: remainingLabel(interaction),
        expired: remainingLabel(interaction) === '已超时',
      }
    }
    const count = questionsOf(interaction).length
    return {
      id: interaction.interactionId,
      kind: 'question' as const,
      label: count > 1 ? '提问 ' + count + ' 问' : '提问',
      countdown: remainingLabel(interaction),
      expired: remainingLabel(interaction) === '已超时',
    }
  }),
)
const pendingTab = computed({
  get: () => rootUi.value.pendingTab,
  set: (value: string | null) =>
    liteUi.patchRootUi(props.windowId, props.rootChatId, { pendingTab: value }),
})
/** 激活的待处理交互 id：null=收起；无有效 pendingTab 时自动回退到第一个 Tab（保持「有新交互即展示」）。 */
const activePendingTabId = computed<string | null>(() => {
  if (pendingTab.value && pendingTabs.value.some((tab) => tab.id === pendingTab.value)) {
    return pendingTab.value
  }
  return pendingTabs.value[0]?.id ?? null
})
/** 激活的待处理交互（内容面板据此渲染；不在可操作列表时回退为 null）。 */
const activeInteraction = computed<LiteInteraction | null>(() => {
  const id = activePendingTabId.value
  if (!id) return null
  return lite.interactions.find((item) => item.interactionId === id) ?? null
})

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
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  freeText: boolean
}
function questionsOf(interaction: LiteInteraction): QuestionView[] {
  const questions = interaction.payload.questions
  if (!Array.isArray(questions)) return []
  return (questions as Array<Record<string, unknown>>).map((question) => ({
    questionId: typeof question.questionId === 'string' ? question.questionId : '',
    question: typeof question.question === 'string' ? question.question : '',
    options: Array.isArray(question.options)
      ? (question.options as Array<{ label: string; description?: string }>)
      : [],
    multiSelect: question.multiSelect === true,
    freeText: !Array.isArray(question.options) || question.options.length === 0,
  }))
}
const questionDrafts = computed({
  get: () => rootUi.value.interactionDrafts,
  set: (value: Record<string, Record<string, LiteQuestionDraft>>) =>
    liteUi.patchRootUi(props.windowId, props.rootChatId, { interactionDrafts: value }),
})
function draftOf(batchId: string, questionId: string): LiteQuestionDraft {
  return questionDrafts.value[batchId]?.[questionId] ?? { selected: [], notes: {}, freeText: '' }
}
function selectedOf(batchId: string, questionId: string): string[] {
  return draftOf(batchId, questionId).selected
}
function noteOf(batchId: string, questionId: string, label: string): string {
  return draftOf(batchId, questionId).notes[label] ?? ''
}
function toggleOption(batchId: string, question: QuestionView, label: string): void {
  const batch = { ...questionDrafts.value[batchId] }
  const draft = draftOf(batchId, question.questionId)
  const current = new Set(draft.selected)
  const next = { ...draft }
  if (question.multiSelect) {
    if (current.has(label)) {
      current.delete(label)
      const { [label]: _removed, ...rest } = next.notes
      next.notes = rest
    } else current.add(label)
    next.selected = [...current]
  } else {
    next.selected = current.has(label) ? [] : [label]
    // 单选切选项：丢弃非当前选项的补充描述
    next.notes = current.has(label)
      ? {}
      : { ...(next.notes[label] ? { [label]: next.notes[label] } : {}) }
  }
  batch[question.questionId] = next
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
function setOptionNote(batchId: string, questionId: string, label: string, value: string): void {
  const batch = { ...questionDrafts.value[batchId] }
  const draft = draftOf(batchId, questionId)
  batch[questionId] = { ...draft, notes: { ...draft.notes, [label]: value } }
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
function textDraftOf(batchId: string, questionId: string): string {
  return draftOf(batchId, questionId).freeText
}
function setTextDraft(batchId: string, questionId: string, value: string): void {
  const batch = { ...questionDrafts.value[batchId] }
  const draft = draftOf(batchId, questionId)
  batch[questionId] = { ...draft, freeText: value }
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
const answering = ref<string | null>(null)
async function onAnswerBatch(interaction: LiteInteraction): Promise<void> {
  const batchId = interaction.interactionId
  const answers = questionsOf(interaction).map((question) => {
    const draft = draftOf(batchId, question.questionId)
    if (question.freeText) {
      return {
        questionId: question.questionId,
        freeText: draft.freeText,
      }
    }
    const notes: Record<string, string> = {}
    for (const label of draft.selected) {
      const note = draft.notes[label]?.trim()
      if (note) notes[label] = note
    }
    return {
      questionId: question.questionId,
      selectedLabels: draft.selected,
      ...(Object.keys(notes).length ? { optionNotes: notes } : {}),
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
const connectionBlocked = computed(() => !lite.commandGate.allowed)
const operationBlockReason = computed(() =>
  lite.commandGate.allowed ? '' : lite.commandGate.reason,
)
const liteInputEl = ref<HTMLInputElement | null>(null)
/** t10：hydration/命令门从禁用→放行时聚焦 lite 输入框——新建会话 hydration 完成后立即可用，无需切页。 */
watch(
  () => lite.commandGate.allowed,
  (allowed, wasBlocked) => {
    if (allowed && wasBlocked === false) void nextTick(() => liteInputEl.value?.focus())
  },
)

// 倒计时（需求 2）：仅运行中（pending/resolving）的节点计算倒计时；终态节点只显示状态。
function remainingLabel(interaction: LiteInteraction): string {
  void clock.now.value
  if (interaction.status !== 'pending' && interaction.status !== 'resolving') return ''
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
/** t20：t18 合成的 in-flight 占位节点（无持久内容）——禁用详情入口，避免抽屉对不存在节点报错。 */
function isInFlightNode(node: LiteRunNode): boolean {
  return node.nodeId.startsWith('inflight:')
}
function showDetail(
  nodeId: string,
  section: LiteDetailSectionName | null,
  focusToolCallId: string | null,
  event?: Event,
): void {
  // in-flight 占位节点无持久内容，直接跳过（行内详情按钮 / cluster 点击 / 审批定位均走此门禁）。
  if (nodeId.startsWith('inflight:')) return
  focusNodeId.value = null
  rememberDetailTrigger(event)
  liteUi.patchRootUi(props.windowId, props.rootChatId, {
    detailNodeId: nodeId,
    detailInitialSection: section,
    detailFocusToolCallId: focusToolCallId,
  })
}
/** 节点「详情」（需求 3）：只展示该节点本身的信息（思考/正文/工具调用）。 */
function openNodeDetail(node: LiteRunNode, event: Event): void {
  showDetail(node.nodeId, node.kind === 'tool' ? 'toolCalls' : null, null, event)
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

// t14：点击时间轴节点 → 定位/高亮下方对应内容块（不再拉出侧边窗）。
const focusNodeId = ref<string | null>(null)
const rowEls = new Map<string, HTMLElement | null>()
function setRowEl(key: string, el: unknown): void {
  rowEls.set(key, (el as HTMLElement | null) ?? null)
}
function rowKeyForNodeId(nodeId: string): string | null {
  const rows = history.value.rows
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (!row) continue
    if (row.kind === 'full') {
      if (row.node && row.node.nodeId === nodeId) return rowKey(row)
    } else if (row.nodes && row.nodes.some((item) => item.nodeId === nodeId)) {
      return rowKey(row)
    }
  }
  return null
}
function rowKeyForNode(node: LiteRunNode): string | null {
  return rowKeyForNodeId(node.nodeId)
}
function isRowFocused(row: LiteRunRow): boolean {
  const id = focusNodeId.value
  if (!id) return false
  if (row.kind === 'full') return row.node?.nodeId === id
  return Boolean(row.nodes && row.nodes.some((item) => item.nodeId === id))
}
function flashRow(el: HTMLElement): void {
  el.classList.remove('lite-flash')
  void el.offsetWidth
  el.classList.add('lite-flash')
}
/** t14 定位：把 focusNodeId 对应内容行滚入 monitor 可视区并高亮。 */
function locateNode(nodeId: string): void {
  focusNodeId.value = nodeId
  const key = rowKeyForNodeId(nodeId)
  const el = key ? (rowEls.get(key) ?? null) : null
  const mon = monitorEl.value
  if (el && mon) {
    const rect = el.getBoundingClientRect()
    const monRect = mon.getBoundingClientRect()
    const rowTop = rect.top - monRect.top + mon.scrollTop
    const rowBottom = rowTop + rect.height
    if (rowTop < mon.scrollTop) mon.scrollTop = Math.max(0, rowTop - 6)
    else if (rowBottom > mon.scrollTop + mon.clientHeight) {
      mon.scrollTop = rowBottom - mon.clientHeight + 6
    }
    flashRow(el)
  }
}
function focusNodeFromTrajectory(node: LiteRunNode, event: Event): void {
  locateNode(node.nodeId)
}

// t16：hover 放大 + tip 展示详情（时间轴 bar 悬停浮层）。
const hoverNode = ref<LiteRunNode | null>(null)
const tipPos = ref({ x: 0, y: 0 })
function showBarTip(node: LiteRunNode, event: PointerEvent): void {
  hoverNode.value = node
  tipPos.value.x = event.clientX
  tipPos.value.y = event.clientY
}
function moveBarTip(event: PointerEvent): void {
  if (!hoverNode.value) return
  tipPos.value.x = event.clientX
  tipPos.value.y = event.clientY
}
function hideBarTip(): void {
  hoverNode.value = null
}
function nodeKindLabel(node: LiteRunNode): string {
  if (node.kind === 'tool') return `${toolTypeEmoji(node.toolType)} 工具`
  if (node.kind === 'user') return '用户消息'
  return '模型响应'
}

// t16：MCU 方向键选中（预留）——左右/上下移动时间轴 bar 焦点并同步定位高亮。
function onTrajectoryKeydown(event: KeyboardEvent): void {
  const target = event.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('lite-trajectory-bar')) return
  const section = event.currentTarget
  if (!(section instanceof HTMLElement)) return
  const bars = Array.from(
    section.querySelectorAll<HTMLButtonElement>('.lite-trajectory-bar'),
  ).filter((el) => !el.disabled)
  const index = bars.indexOf(target as HTMLButtonElement)
  if (index < 0) return
  let next = -1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index + 1
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = bars.length - 1
  else return
  if (next < 0 || next >= bars.length) return
  event.preventDefault()
  const el = bars[next]
  if (!el) return
  el.focus()
  const nodeId = el.dataset.nodeId
  if (nodeId) locateNode(nodeId)
}

// t15：运行时长分级（运行时间变色）——快/中/久三档，用块边框颜色表达。
function durationTier(elapsedMs: number): 'fast' | 'medium' | 'long' | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null
  const seconds = elapsedMs / 1000
  if (seconds < 10) return 'fast'
  if (seconds < 30) return 'medium'
  return 'long'
}

// ── 时间瀑布流（需求 2/4d-3/5：多轨多 Agent，参考浏览器控制台请求时间线窗口）──
const TRAJECTORY_PX_PER_SECOND = 14
const TRAJECTORY_PAD_MS = 2000
const TRAJECTORY_MAX_TRACK_WIDTH = 1600
const MIN_BAR_PX = 5
const BAR_LOG_K = 4.5
const WAIT_THRESHOLD_MS = 3000
const TRAJECTORY_NONLINEAR_K = 8
interface TrajectoryBar {
  node: LiteRunNode
  left: number
  width: number
}
interface TrajectoryWait {
  left: number
  width: number
  gapMs: number
}
interface TrajectoryTrack {
  chatId: string
  agentLabel: string
  bars: TrajectoryBar[]
  waits: TrajectoryWait[]
}
interface TrajectoryLayout {
  tracks: TrajectoryTrack[]
  trackWidth: number
  minTime: number
  maxTime: number
}
/** 时长 → 渐近压缩宽度：minPx + k*log(1+t)，短节点保持可见、长节点亚线性增长。 */
function compressedBarWidth(elapsedMs: number): number {
  const seconds = Math.max(0, elapsedMs) / 1000
  return Math.max(MIN_BAR_PX, MIN_BAR_PX + BAR_LOG_K * Math.log(1 + seconds))
}
function trajectoryLayout(width: number, zoom = 1): TrajectoryLayout {
  const nodes = history.value.nodes
  if (!nodes.length) return { tracks: [], trackWidth: 0, minTime: 0, maxTime: 0 }
  let minTime = Infinity
  let maxTime = -Infinity
  for (const node of nodes) {
    minTime = Math.min(minTime, node.startedAt)
    maxTime = Math.max(
      maxTime,
      node.startedAt,
      node.completedAt ?? 0,
      node.startedAt + node.elapsedMs,
    )
  }
  minTime -= TRAJECTORY_PAD_MS
  maxTime += TRAJECTORY_PAD_MS
  const spanMs = Math.max(1, maxTime - minTime)
  // 轨道宽度随会话时长次线性增长并封顶：长时间会话压缩在固定宽度内，配合横向超细滚动条。
  // zoom（t13 滚轮缩放）：Ctrl/⌘+滚轮整体缩放时间比例尺，调整瀑布流横向密度。
  const scaled = Math.ceil((spanMs / 1000) * TRAJECTORY_PX_PER_SECOND * zoom)
  const trackWidth = Math.max(width, Math.min(TRAJECTORY_MAX_TRACK_WIDTH * zoom, scaled))
  // 时间→x 的非线性（近期加权）映射：压缩长空闲区间，近期活动保留更多横向空间。
  const logK1 = Math.log(1 + TRAJECTORY_NONLINEAR_K)
  const xOf = (t: number): number => {
    const T = Math.min(1, Math.max(0, (t - minTime) / spanMs))
    const g = Math.log(1 + TRAJECTORY_NONLINEAR_K * (1 - T)) / logK1
    return (1 - g) * trackWidth
  }
  const byChat = new Map<string, LiteRunNode[]>()
  for (const node of nodes) {
    const list = byChat.get(node.sourceChatId)
    if (list) list.push(node)
    else byChat.set(node.sourceChatId, [node])
  }
  const tracks: TrajectoryTrack[] = []
  for (const [chatId, list] of byChat) {
    const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key))
    const bars = sorted.map((node) => ({
      node,
      left: xOf(node.startedAt),
      width: compressedBarWidth(node.elapsedMs),
    }))
    // 长空闲（等待）区间 → 虚线块
    const waits: TrajectoryWait[] = []
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]
      const next = sorted[i]
      if (!prev || !next) continue
      const prevEnd = Math.max(prev.startedAt, prev.completedAt ?? prev.startedAt)
      const gapMs = next.startedAt - prevEnd
      if (gapMs > WAIT_THRESHOLD_MS) {
        const left = xOf(prevEnd)
        const right = xOf(next.startedAt)
        waits.push({ left, width: Math.max(MIN_BAR_PX, right - left), gapMs })
      }
    }
    tracks.push({
      chatId,
      agentLabel: list[0]?.agentLabel ?? (chatId === lite.rootChatId ? '主 Agent' : '子 Agent'),
      bars,
      waits,
    })
  }
  tracks.sort(
    (a, b) =>
      (a.bars[0]?.node.startedAt ?? 0) - (b.bars[0]?.node.startedAt ?? 0) ||
      a.chatId.localeCompare(b.chatId),
  )
  return { tracks, trackWidth, minTime, maxTime }
}
function trajectoryLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

// t13 滚轮缩放：Ctrl/⌘+滚轮在 0.4x–5x 之间缩放时间比例尺；普通滚轮仍走 LiteScrollbar 的横向平移。
const TRAJECTORY_ZOOM_MIN = 0.4
const TRAJECTORY_ZOOM_MAX = 5
const trajectoryZoom = ref(1)
function onTrajectoryWheel(event: WheelEvent): void {
  if (!(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  event.stopPropagation()
  const factor = event.deltaY < 0 ? 1.12 : 0.89
  trajectoryZoom.value = Math.min(
    TRAJECTORY_ZOOM_MAX,
    Math.max(TRAJECTORY_ZOOM_MIN, +(trajectoryZoom.value * factor).toFixed(2)),
  )
}
function resetTrajectoryZoom(): void {
  trajectoryZoom.value = 1
}

// ── 详情抽屉：只展示选中的那一个节点（需求 3）──
const detailNode = computed<LiteRunNode | null>(() => {
  const id = rootUi.value.detailNodeId
  if (!id) return null
  return history.value.nodes.find((node) => node.nodeId === id) ?? null
})
const detailNodeIndex = computed(() => {
  const node = detailNode.value
  return node ? history.value.nodes.findIndex((item) => item.nodeId === node.nodeId) : -1
})
function isDetailNode(node: LiteRunNode): boolean {
  return node.nodeId === rootUi.value.detailNodeId
}
function rowKey(row: LiteRunRow): string {
  if (row.kind === 'full' && row.node) return row.node.key
  return (row.nodes ?? []).map((node) => node.key).join('|')
}
</script>

<template>
  <div class="lite-view" :data-window="props.windowId">
    <header class="lite-statusbar">
      <span class="lite-status-dot" :data-tone="liteStatus.tone" aria-hidden="true" />
      <span class="lite-status-text">轻量状态：{{ liteStatus.text }}</span>
      <span v-if="hydrationLabel" class="lite-hydration">{{ hydrationLabel }}</span>
      <span class="lite-node-count">{{ history.nodes.length }} 节点</span>
      <span class="lite-session">{{ props.presetName || '会话' }}</span>
      <time class="lite-total" aria-label="总耗时"
        >总耗时 {{ formatElapsed(monitor.elapsedMs) }}</time
      >
      <div class="lite-run-controls">
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
    </header>

    <div class="lite-body">
      <section v-if="pendingTabs.length" class="lite-pending-bar" aria-label="待处理操作">
        <button
          v-for="tab in pendingTabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="lite-pending-tab"
          :class="[
            { 'is-active': tab.id === activePendingTabId, 'is-expired': tab.expired },
            'is-' + tab.kind,
          ]"
          :aria-selected="tab.id === activePendingTabId"
          @click="pendingTab = tab.id"
        >
          <span class="lite-pending-tab-label">{{ tab.label }}</span>
          <span v-if="tab.countdown" class="lite-pending-badge" :data-expired="tab.expired">
            {{ tab.countdown }}
          </span>
        </button>
      </section>

      <section v-if="activeInteraction" class="lite-pending-panel" aria-label="待处理详情">
        <div
          v-if="activeInteraction.kind === 'approval'"
          class="lite-interaction"
          :data-status="activeInteraction.status"
        >
          <div class="lite-interaction-head">
            <strong
              >审批：{{
                activeInteraction.payload.senseName ?? activeInteraction.interactionId.slice(0, 8)
              }}</strong
            >
            <span class="lite-interaction-head-right">
              <span
                v-if="activeInteraction.status !== 'pending'"
                class="lite-status-pill"
                :data-status="activeInteraction.status"
                >{{ interactionStatusLabel(activeInteraction) }}</span
              >
              <span
                v-if="remainingLabel(activeInteraction)"
                class="lite-countdown"
                :data-expired="remainingLabel(activeInteraction) === '已超时'"
              >
                {{ remainingLabel(activeInteraction) }}
              </span>
            </span>
          </div>
          <p class="lite-risk-summary">{{ approvalRiskSummary(activeInteraction) }}</p>
          <p
            v-if="lite.interactionError(activeInteraction.interactionId)"
            class="lite-object-error"
            role="alert"
          >
            {{ lite.interactionError(activeInteraction.interactionId)?.message }}
          </p>
          <button
            type="button"
            class="lite-view-full"
            :disabled="!approvalDetailNodeId(activeInteraction)"
            @click="openApprovalDetail(activeInteraction, $event)"
          >
            查看工具详情
          </button>
          <div v-if="interactionActionable(activeInteraction)" class="lite-interaction-actions">
            <button
              type="button"
              class="lite-btn is-accept"
              :disabled="
                deciding === activeInteraction.interactionId ||
                remainingLabel(activeInteraction) === '已超时' ||
                connectionBlocked
              "
              @click="onDecide(activeInteraction, 'accept')"
            >
              {{ deciding === activeInteraction.interactionId ? '处理中…' : '允许' }}
            </button>
            <button
              type="button"
              class="lite-btn is-reject"
              :disabled="
                deciding === activeInteraction.interactionId ||
                remainingLabel(activeInteraction) === '已超时' ||
                connectionBlocked
              "
              @click="onDecide(activeInteraction, 'reject')"
            >
              {{ deciding === activeInteraction.interactionId ? '处理中…' : '拒绝' }}
            </button>
          </div>
        </div>
        <div v-else class="lite-interaction" :data-status="activeInteraction.status">
          <div class="lite-interaction-head">
            <strong>提问</strong>
            <span class="lite-interaction-head-right">
              <span
                v-if="activeInteraction.status !== 'pending'"
                class="lite-status-pill"
                :data-status="activeInteraction.status"
                >{{ interactionStatusLabel(activeInteraction) }}</span
              >
              <span
                v-if="remainingLabel(activeInteraction)"
                class="lite-countdown"
                :data-expired="remainingLabel(activeInteraction) === '已超时'"
              >
                {{ remainingLabel(activeInteraction) }}
              </span>
            </span>
          </div>
          <div
            v-for="question in questionsOf(activeInteraction)"
            :key="question.questionId"
            class="lite-followup-question"
          >
            <p>{{ question.question }}</p>
            <p
              v-if="lite.questionError(activeInteraction.interactionId, question.questionId)"
              class="lite-question-error"
              role="alert"
            >
              {{
                lite.questionError(activeInteraction.interactionId, question.questionId)?.message
              }}
            </p>
            <template v-if="!question.freeText">
              <div v-for="option in question.options" :key="option.label" class="lite-option-wrap">
                <label class="lite-option">
                  <input
                    :type="question.multiSelect ? 'checkbox' : 'radio'"
                    :name="activeInteraction.interactionId + ':' + question.questionId"
                    :disabled="!interactionActionable(activeInteraction)"
                    :checked="
                      selectedOf(activeInteraction.interactionId, question.questionId).includes(
                        option.label,
                      )
                    "
                    @change="toggleOption(activeInteraction.interactionId, question, option.label)"
                  />
                  <span class="lite-option-label">{{ option.label }}</span>
                  <span v-if="option.description" class="lite-option-description">{{
                    option.description
                  }}</span>
                </label>
                <textarea
                  v-if="
                    selectedOf(activeInteraction.interactionId, question.questionId).includes(
                      option.label,
                    )
                  "
                  class="lite-option-note"
                  rows="2"
                  :value="
                    noteOf(activeInteraction.interactionId, question.questionId, option.label)
                  "
                  :disabled="!interactionActionable(activeInteraction)"
                  placeholder="为这个选项补充描述（可选）"
                  @input="
                    setOptionNote(
                      activeInteraction.interactionId,
                      question.questionId,
                      option.label,
                      ($event.target as HTMLTextAreaElement).value,
                    )
                  "
                />
              </div>
            </template>
            <textarea
              v-else
              class="lite-freetext"
              rows="2"
              :value="textDraftOf(activeInteraction.interactionId, question.questionId)"
              :disabled="!interactionActionable(activeInteraction)"
              placeholder="输入回答"
              @input="
                setTextDraft(
                  activeInteraction.interactionId,
                  question.questionId,
                  ($event.target as HTMLTextAreaElement).value,
                )
              "
            />
          </div>
          <p
            v-if="lite.interactionError(activeInteraction.interactionId)"
            class="lite-object-error"
            role="alert"
          >
            {{ lite.interactionError(activeInteraction.interactionId)?.message }}
          </p>
          <div v-if="interactionActionable(activeInteraction)" class="lite-interaction-actions">
            <button
              type="button"
              class="lite-btn is-accept"
              :disabled="answering === activeInteraction.interactionId || connectionBlocked"
              @click="onAnswerBatch(activeInteraction)"
            >
              提交回答
            </button>
          </div>
        </div>
      </section>
      <section
        v-if="history.nodes.length"
        class="lite-trajectory"
        aria-label="运行轨迹时间线"
        @wheel.capture="onTrajectoryWheel"
        @keydown="onTrajectoryKeydown"
      >
        <span class="lite-trajectory-head">
          <span class="lite-trajectory-title">时间轴</span>
          <button
            v-if="trajectoryZoom !== 1"
            type="button"
            class="lite-trajectory-zoom"
            :title="'重置缩放（Ctrl/⌘ + 滚轮缩放）'"
            @click="resetTrajectoryZoom"
          >
            {{ Math.round(trajectoryZoom * 100) }}%
          </button>
        </span>
        <LiteScrollbar axis="x">
          <template #default="{ width }">
            <div
              class="lite-trajectory-track"
              :style="{ width: trajectoryLayout(width, trajectoryZoom).trackWidth + 'px' }"
            >
              <div
                v-for="track in trajectoryLayout(width, trajectoryZoom).tracks"
                :key="track.chatId"
                class="lite-trajectory-lane"
                :aria-label="track.agentLabel + ' 时间轴'"
              >
                <div class="lite-trajectory-lane-label">
                  <span
                    class="lite-trajectory-lane-dot"
                    :data-root="track.chatId === lite.rootChatId"
                  />
                  {{ track.agentLabel }}
                </div>
                <div class="lite-trajectory-lane-track">
                  <span
                    v-for="(wait, index) in track.waits"
                    :key="'wait-' + index"
                    class="lite-trajectory-wait"
                    :style="{ left: wait.left + 'px', width: wait.width + 'px' }"
                    :title="'等待 ' + formatElapsed(wait.gapMs)"
                  />
                  <button
                    v-for="bar in track.bars"
                    :key="bar.node.key"
                    type="button"
                    class="lite-trajectory-bar"
                    :class="[
                      'is-' + bar.node.kind,
                      bar.node.kind === 'tool'
                        ? 'is-tooltype-' + (bar.node.toolType ?? 'other')
                        : '',
                      {
                        'is-running': bar.node.active,
                        'is-selected': isDetailNode(bar.node),
                        'is-focused': bar.node.nodeId === focusNodeId,
                      },
                    ]"
                    :data-kind="bar.node.kind"
                    :data-tooltype="bar.node.toolType"
                    :data-node-id="bar.node.nodeId"
                    :style="{ left: bar.left + 'px', width: bar.width + 'px' }"
                    :title="
                      bar.node.label +
                      ' · ' +
                      runStatusLabel(bar.node.status) +
                      ' · 点击定位下方内容'
                    "
                    @pointerenter="showBarTip(bar.node, $event)"
                    @pointermove="moveBarTip"
                    @pointerleave="hideBarTip"
                    @click="focusNodeFromTrajectory(bar.node, $event)"
                  />
                </div>
              </div>
              <span class="lite-trajectory-axis">
                <time>{{ trajectoryLabel(0) }}</time>
                <time>{{
                  trajectoryLabel(
                    trajectoryLayout(width, trajectoryZoom).maxTime -
                      trajectoryLayout(width, trajectoryZoom).minTime,
                  )
                }}</time>
              </span>
            </div>
          </template>
        </LiteScrollbar>
      </section>

      <main ref="monitorEl" class="lite-monitor" aria-label="执行监控" @scroll="onMonitorScroll">
        <ol v-if="history.rows.length" class="lite-history">
          <li
            v-for="row in history.rows"
            :key="rowKey(row)"
            :ref="(el) => setRowEl(rowKey(row), el)"
            class="lite-history-row"
            :class="[
              row.kind === 'cluster'
                ? ['is-cluster']
                : [`is-${row.node?.kind}`, { 'is-round-start': row.node?.kind === 'user' }],
              { 'is-focused': isRowFocused(row) },
            ]"
          >
            <template v-if="row.kind === 'full' && row.node">
              <div class="lite-history-summary">
                <span class="lite-history-icon" aria-hidden="true">{{ row.node.icon }}</span>
                <div class="lite-history-meta">
                  <strong>{{ row.node.label }}</strong>
                  <span class="lite-history-status">{{ runStatusLabel(row.node.status) }}</span>
                  <time v-if="row.node.elapsedMs > 0">{{ formatElapsed(row.node.elapsedMs) }}</time>
                </div>
                <button
                  v-if="row.node && !isInFlightNode(row.node)"
                  type="button"
                  class="lite-history-detail"
                  @click="openNodeDetail(row.node, $event)"
                >
                  详情
                </button>
              </div>
              <p
                v-if="row.node.kind === 'user' || row.node.isRoundFinal"
                class="lite-history-content"
              >
                {{ row.node.content || '（空）' }}
              </p>
            </template>
            <div v-else class="lite-cluster" role="group" aria-label="本轮中间节点">
              <button
                v-for="node in row.nodes"
                :key="node.key"
                type="button"
                class="lite-cluster-node"
                :class="[
                  `is-${node.kind}`,
                  `is-status-${node.status}`,
                  {
                    'is-selected': isDetailNode(node),
                    'is-focused': node.nodeId === focusNodeId,
                  },
                ]"
                :data-status="node.status"
                :data-duration="node.active ? durationTier(node.elapsedMs) : null"
                :title="`${node.label} · ${runStatusLabel(node.status)}`"
                @click="openNodeDetail(node, $event)"
              >
                <span class="lite-cluster-dot" :data-status="node.status" aria-hidden="true" />
                <span class="lite-cluster-icon" aria-hidden="true">{{ node.icon }}</span>
                <span
                  v-if="node.kind === 'tool'"
                  class="lite-cluster-type"
                  :data-tooltype="node.toolType"
                  aria-hidden="true"
                  :title="node.toolType"
                  >{{ toolTypeEmoji(node.toolType) }}</span
                >
                <span class="lite-cluster-elapsed">{{
                  node.elapsedMs > 0 ? formatElapsed(node.elapsedMs) : ''
                }}</span>
              </button>
            </div>
          </li>
        </ol>
        <p v-else class="lite-empty">{{ monitor.question ? '暂无执行节点' : '等待输入问题' }}</p>
      </main>

      <div
        v-if="lite.outgoingMessages.some((message) => message?.delivery?.status === 'failed')"
        class="lite-failed-inputs"
      >
        <div
          v-for="message in lite.outgoingMessages.filter(
            (item) => item?.delivery?.status === 'failed',
          )"
          :key="message.msgId"
          class="lite-failed-input"
        >
          <span>{{ message.delivery?.error?.message ?? '发送失败' }}</span>
          <button type="button" @click="lite.retryInput(message.msgId)">重试</button>
          <button type="button" @click="lite.removeFailedInput(message.msgId)">移除</button>
        </div>
      </div>

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

      <div class="lite-input">
        <input
          ref="liteInputEl"
          v-model="inputText"
          type="text"
          class="lite-input-box"
          :placeholder="connectionBlocked ? operationBlockReason : '发送消息（Enter）'"
          :disabled="sending || connectionBlocked"
          @keydown="onInputKeydown"
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
        :node="detailNode"
        :node-index="detailNodeIndex"
        :focus-tool-call-id="rootUi.detailFocusToolCallId"
        :initial-section="rootUi.detailInitialSection"
        @close="closeDetail"
      />

      <!-- t16：时间轴 bar 悬停 tip（详情浮层，跟随鼠标） -->
      <Teleport to="body">
        <div
          v-if="hoverNode"
          class="lite-tip"
          :style="{ left: tipPos.x + 'px', top: tipPos.y + 'px' }"
        >
          <span class="lite-tip-head">
            <span class="lite-tip-icon" aria-hidden="true">{{ hoverNode.icon }}</span>
            <strong>{{ hoverNode.label }}</strong>
          </span>
          <span class="lite-tip-row">
            <span class="lite-tip-key">状态</span>
            {{ runStatusLabel(hoverNode.status) }}
          </span>
          <span class="lite-tip-row">
            <span class="lite-tip-key">耗时</span>
            {{ hoverNode.elapsedMs > 0 ? formatElapsed(hoverNode.elapsedMs) : '—' }}
          </span>
          <span class="lite-tip-row">
            <span class="lite-tip-key">类型</span>
            {{ nodeKindLabel(hoverNode) }}
          </span>
          <span v-if="hoverNode.agentLabel" class="lite-tip-row">
            <span class="lite-tip-key">Agent</span>
            {{ hoverNode.agentLabel }}
          </span>
        </div>
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.lite-view {
  flex: 1;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-size: 13px;
}

/* ── 顶部状态栏：轻量状态 + 节点数（需求 2：去掉「已连接」，改为轻量状态/节点数）── */
.lite-statusbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.lite-status-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}
.lite-status-dot[data-tone='busy'] {
  background: var(--el-color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--el-color-primary) 22%, transparent);
  animation: lite-pulse 1.4s ease-in-out infinite;
}
.lite-status-dot[data-tone='ok'] {
  background: var(--el-color-success);
}
.lite-status-dot[data-tone='danger'] {
  background: var(--el-color-danger);
}
@keyframes lite-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
.lite-status-text {
  flex: none;
  white-space: nowrap;
}
.lite-hydration {
  flex: none;
  color: var(--el-color-warning);
}
.lite-node-count {
  flex: none;
  padding: 0 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
.lite-session {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lite-total {
  flex: none;
  font-variant-numeric: tabular-nums;
}
.lite-run-controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.lite-inline-action {
  border: 1px solid transparent;
  background: transparent;
  color: var(--el-color-primary);
  cursor: pointer;
  font-size: 12px;
  padding: 1px 6px;
  border-radius: 4px;
}
.lite-inline-action:hover:not(:disabled) {
  border-color: var(--el-color-primary-light-5);
  background: color-mix(in srgb, var(--el-color-primary) 8%, transparent);
}
.lite-inline-action:disabled {
  cursor: default;
  opacity: 0.5;
}

/* 主体容器：DetailDrawer 在此 absolute 定位（需求 3a：标题栏下方开始，不盖标题栏） */
.lite-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ── 时间瀑布流（需求 2/4d-3/5：多轨多 Agent，顶部外挂、参考浏览器控制台请求时间线窗口）── */
.lite-trajectory {
  position: relative;
  flex: none;
  padding: 5px 12px 2px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  max-height: 132px;
  overflow-y: auto;
  scrollbar-width: none;
}
.lite-trajectory-head {
  position: absolute;
  top: 3px;
  left: 6px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  line-height: 1;
  color: var(--el-text-color-secondary);
  background: color-mix(in srgb, var(--el-bg-color) 82%, transparent);
  border-radius: 6px;
  padding: 2px 6px;
  pointer-events: none;
}
.lite-trajectory-zoom {
  pointer-events: auto;
  border: none;
  background: color-mix(in srgb, var(--el-color-primary) 14%, transparent);
  color: var(--el-color-primary);
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 10.5px;
  line-height: 1.4;
  cursor: pointer;
}
.lite-trajectory-zoom:hover {
  background: color-mix(in srgb, var(--el-color-primary) 24%, transparent);
}
.lite-trajectory-lane-label {
  padding-right: 64px;
}
.lite-trajectory::-webkit-scrollbar {
  display: none;
}
.lite-trajectory :deep(.lite-scrollbar) {
  height: 100%;
}
.lite-trajectory-track {
  position: relative;
  min-width: 100%;
  padding-bottom: 15px;
}
.lite-trajectory-lane {
  position: relative;
  margin-bottom: 5px;
}
.lite-trajectory-lane-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  line-height: 14px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lite-trajectory-lane-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}
.lite-trajectory-lane-dot[data-root='true'] {
  background: var(--el-color-primary);
}
.lite-trajectory-lane-track {
  position: relative;
  height: 13px;
}
.lite-trajectory-wait {
  position: absolute;
  top: 3px;
  height: 7px;
  border: 1px dashed var(--el-text-color-placeholder);
  border-radius: 3px;
  opacity: 0.6;
  pointer-events: none;
  box-sizing: border-box;
}
.lite-trajectory-bar {
  position: absolute;
  top: 0;
  height: 13px;
  border: none;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  opacity: 0.72;
  transition:
    opacity 120ms ease,
    box-shadow 120ms ease,
    transform 120ms ease;
}
/* t16：hover 放大（垂直放大到约 1.75 倍，置顶显示） */
.lite-trajectory-bar:hover {
  opacity: 1;
  z-index: 3;
  transform: scaleY(1.75);
  transform-origin: center;
}
.lite-trajectory-bar.is-user {
  background: var(--el-color-primary);
}
.lite-trajectory-bar.is-model {
  background: var(--el-color-success);
}
.lite-trajectory-bar.is-tool {
  background: var(--el-color-warning);
}
/* 按工具类型配色（需求 5） */
.lite-trajectory-bar.is-tool[data-tooltype='exec'] {
  background: #9b59b6;
}
.lite-trajectory-bar.is-tool[data-tooltype='read'] {
  background: var(--el-color-info);
}
.lite-trajectory-bar.is-tool[data-tooltype='write'] {
  background: var(--el-color-success);
}
.lite-trajectory-bar.is-tool[data-tooltype='web'] {
  background: #00a8a8;
}
.lite-trajectory-bar.is-tool[data-tooltype='dispatch'] {
  background: #e67e22;
}
.lite-trajectory-bar.is-tool[data-tooltype='other'] {
  background: var(--el-color-warning);
}
.lite-trajectory-bar.is-running {
  opacity: 1;
  animation: lite-pulse 1.4s ease-in-out infinite;
}
.lite-trajectory-bar.is-selected {
  outline: 2px solid var(--el-text-color-primary);
  outline-offset: 1px;
  opacity: 1;
  z-index: 3;
}
.lite-trajectory-axis {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: space-between;
  color: var(--el-text-color-placeholder);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
}

/* ── 运行历史列表（需求 1c / 4a）：用户消息与轮末响应独占一行，中间节点为 cluster 小按钮 ── */
.lite-monitor {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 12px;
  scrollbar-width: none;
}
.lite-monitor::-webkit-scrollbar {
  display: none;
}
.lite-history {
  list-style: none;
  margin: 0;
  padding: 0;
}
.lite-history-row {
  margin-top: 6px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
}
.lite-history-row.is-round-start {
  border-color: color-mix(in srgb, var(--el-color-primary) 38%, var(--el-border-color));
}
.lite-history-row.is-cluster {
  border-style: dashed;
  border-color: var(--el-border-color);
  background: color-mix(in srgb, var(--el-fill-color-lighter) 55%, transparent);
}
.lite-history-row[data-status='failed'] {
  border-color: var(--el-color-danger-light-5);
}
.lite-history-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
}
.lite-history-icon {
  flex: none;
  width: 18px;
  text-align: center;
  color: var(--el-text-color-secondary);
}
.lite-history-row.is-user .lite-history-icon {
  color: var(--el-color-primary);
}
.lite-history-row.is-tool .lite-history-icon {
  color: var(--el-color-warning);
}
.lite-history-row.is-model .lite-history-icon {
  color: var(--el-color-success);
}
.lite-history-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.lite-history-meta strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lite-history-status {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.lite-history-meta time {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}
.lite-history-detail,
.lite-view-full {
  border: 0;
  background: transparent;
  color: var(--el-color-primary);
  cursor: pointer;
  font-size: 12px;
}
.lite-history-detail:disabled,
.lite-view-full:disabled {
  cursor: default;
  opacity: 0.5;
}
.lite-history-content {
  margin: 0;
  padding: 0 10px 8px 36px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
  font-size: 12.5px;
}
.lite-empty {
  margin: 14px 2px 2px;
  color: var(--el-text-color-placeholder);
}

/* ── cluster 小按钮行（需求 4a/4b）：多个中间节点挤成一行的小按钮，只显示 icon + 状态 ── */
.lite-cluster {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 7px 10px;
}
.lite-cluster-node {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 999px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-secondary);
  cursor: pointer;
  font-size: 11px;
  line-height: 1.6;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease,
    transform 120ms ease;
}
.lite-cluster-node:hover {
  border-color: var(--el-color-primary-light-5);
  transform: translateY(-1px);
}
.lite-cluster-node.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--el-color-primary) 20%, transparent);
}
/* t14：时间轴点击定位 → 高亮下方对应内容块（行 + 具体节点），并做一次短暂闪光动画。 */
.lite-history-row.is-focused {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--el-color-primary) 18%, transparent);
}
.lite-history-row.lite-flash {
  animation: lite-focus-flash 900ms ease;
}
@keyframes lite-focus-flash {
  0% {
    box-shadow: 0 0 0 2px var(--el-color-primary);
    background: color-mix(in srgb, var(--el-color-primary) 16%, transparent);
  }
  100% {
    box-shadow: 0 0 0 2px transparent;
    background: transparent;
  }
}
.lite-cluster-node.is-focused {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
  border-color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
}
.lite-trajectory-bar.is-focused {
  outline: 2px solid var(--el-text-color-primary);
  outline-offset: 1px;
  opacity: 1;
  z-index: 3;
}
/* t16：时间轴 bar 悬停详情浮层（跟随鼠标，fixed 定位） */
.lite-tip {
  position: fixed;
  z-index: 4000;
  transform: translate(10px, 12px);
  max-width: 280px;
  padding: 6px 9px;
  border-radius: 8px;
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color-overlay, var(--el-bg-color));
  color: var(--el-text-color-regular);
  font-size: 11.5px;
  line-height: 1.5;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
  pointer-events: none;
  white-space: nowrap;
}
.lite-tip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
  font-size: 12px;
}
.lite-tip-icon {
  color: var(--el-text-color-secondary);
}
.lite-tip-row {
  display: flex;
  gap: 6px;
  color: var(--el-text-color-secondary);
}
.lite-tip-key {
  flex: none;
  color: var(--el-text-color-placeholder);
  min-width: 34px;
}
/* t15：工具小块标记——工具类型 emoji 角标（右上方） */
.lite-cluster-type {
  position: absolute;
  top: -8px;
  right: -5px;
  z-index: 2;
  font-size: 9px;
  line-height: 1;
  padding: 1px 3px;
  border-radius: 999px;
  background: var(--el-fill-color);
  border: 1px solid var(--el-border-color);
  box-shadow: 0 0 0 1px var(--el-bg-color);
  pointer-events: none;
}
.lite-cluster-type[data-tooltype='exec'] {
  background: color-mix(in srgb, #9b59b6 18%, var(--el-fill-color));
}
.lite-cluster-type[data-tooltype='read'] {
  background: color-mix(in srgb, var(--el-color-info) 18%, var(--el-fill-color));
}
.lite-cluster-type[data-tooltype='write'] {
  background: color-mix(in srgb, var(--el-color-success) 18%, var(--el-fill-color));
}
.lite-cluster-type[data-tooltype='web'] {
  background: color-mix(in srgb, #00a8a8 18%, var(--el-fill-color));
}
.lite-cluster-type[data-tooltype='dispatch'] {
  background: color-mix(in srgb, #e67e22 20%, var(--el-fill-color));
}
.lite-cluster-type[data-tooltype='other'] {
  background: color-mix(in srgb, var(--el-color-warning) 18%, var(--el-fill-color));
}
/* t15：运行时间变色——运行中的工具块按运行时长绿→黄→红，运行越久越醒目 */
.lite-cluster-node[data-duration='fast'] {
  border-color: color-mix(in srgb, var(--el-color-success) 72%, var(--el-border-color));
}
.lite-cluster-node[data-duration='medium'] {
  border-color: color-mix(in srgb, var(--el-color-warning) 78%, var(--el-border-color));
}
.lite-cluster-node[data-duration='long'] {
  border-color: var(--el-color-danger);
}
.lite-cluster-node[data-duration='long'] .lite-cluster-dot {
  background: var(--el-color-danger);
  animation: lite-pulse 1.2s ease-in-out infinite;
}
.lite-cluster-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}
.lite-cluster-dot[data-status='running'] {
  background: var(--el-color-primary);
  animation: lite-pulse 1.4s ease-in-out infinite;
}
.lite-cluster-dot[data-status='completed'] {
  background: var(--el-color-success);
}
.lite-cluster-dot[data-status='failed'],
.lite-cluster-dot[data-status='rejected'] {
  background: var(--el-color-danger);
}
.lite-cluster-dot[data-status='cancelled'] {
  background: var(--el-text-color-placeholder);
}
.lite-cluster-icon {
  flex: none;
  font-size: 12px;
  line-height: 1;
}
.lite-cluster-elapsed {
  flex: none;
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--el-text-color-placeholder);
}
.lite-cluster-node.is-status-running {
  border-color: color-mix(in srgb, var(--el-color-primary) 55%, var(--el-border-color));
}
.lite-cluster-node.is-status-failed,
.lite-cluster-node.is-status-rejected {
  border-color: color-mix(in srgb, var(--el-color-danger) 55%, var(--el-border-color));
}

/* ── 顶部待操作 Tab 栏（需求 1a/1b/4e）：外挂在内容窗上方，Element UI tabs 风格，每个交互独立 Tab ── */
.lite-pending-bar {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  padding: 5px 10px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
}
.lite-pending-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px 7px;
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 12.5px;
  cursor: pointer;
  transition: color 120ms ease;
}
.lite-pending-tab:hover {
  color: var(--el-color-primary);
}
.lite-pending-tab.is-active {
  color: var(--el-color-primary);
}
.lite-pending-tab.is-active::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 0;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--el-color-primary);
}
.lite-pending-tab-label {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lite-pending-badge {
  min-width: 14px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--el-color-warning) 16%, transparent);
  color: var(--el-color-warning);
  font-size: 10px;
  text-align: center;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
}
.lite-pending-badge[data-expired='true'] {
  background: color-mix(in srgb, var(--el-color-danger) 16%, transparent);
  color: var(--el-color-danger);
}
/* ── 待处理详情面板：Tab 栏正下方，展示激活的交互卡片 ── */
.lite-pending-panel {
  flex: none;
  max-height: 36%;
  overflow-y: auto;
  padding: 4px 12px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-bg-color);
  scrollbar-width: none;
}
.lite-pending-panel::-webkit-scrollbar {
  display: none;
}

.lite-interaction {
  padding: 6px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}
.lite-interaction:last-child {
  border-bottom: 0;
}
.lite-interaction-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lite-interaction-head-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.lite-status-pill {
  padding: 0 7px;
  border: 1px solid var(--el-border-color);
  border-radius: 999px;
  color: var(--el-text-color-secondary);
  font-size: 10.5px;
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
  font-size: 12px;
  font-variant-numeric: tabular-nums;
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
.lite-object-error,
.lite-question-error {
  margin: 4px 0;
  color: var(--el-color-danger);
  font-size: 12px;
}
.lite-option-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lite-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  cursor: pointer;
}
.lite-option-label {
  min-width: 0;
  flex: 0 0 auto;
}
.lite-option-description {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.4;
}
.lite-option-note {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 5px;
  background: var(--el-fill-color-blank);
  color: inherit;
  resize: vertical;
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
.lite-failed-inputs {
  flex: none;
  padding: 5px 12px;
  border-top: 1px solid var(--el-color-danger-light-7);
  background: var(--el-color-danger-light-9);
}
.lite-failed-input {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--el-color-danger);
  font-size: 12px;
}
.lite-failed-input span {
  flex: 1;
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
  .lite-history-content {
    padding-left: 26px;
  }
}
</style>
