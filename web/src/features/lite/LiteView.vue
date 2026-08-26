<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import { useLiteStore, type LiteQuestionDraft } from './liteStore'
import { useLiteCanonicalView, type LiteInteraction } from './useLiteCanonicalView'
import {
  buildLiteRows,
  createLiteExecutionClock,
  formatElapsed,
  isStandaloneNodeKind,
  isTimedNodeKind,
  LITE_NODE_LABELS,
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

// ── 需求 4：正文列表一次只显示一条链路（主 Agent 链路 / 子 Agent 链路），点击行头 name 切换 ──
const activeLane = ref<string>(props.rootChatId)
watch(
  () => [props.windowId, props.rootChatId] as const,
  ([, rootChatId]) => {
    activeLane.value = rootChatId
  },
  { immediate: true },
)
/** 节点归属链路 id：用户消息并入主 Agent 链路（需求 5：用户消息发给主 Agent）。 */
function laneIdOf(node: LiteRunNode): string {
  return node.kind === 'user' ? props.rootChatId : node.sourceChatId
}
/** 选中链路下的节点（正文列表据此过滤）。 */
const visibleNodes = computed(() =>
  history.value.nodes.filter((node) => laneIdOf(node) === activeLane.value),
)
/** 选中链路下的行（复用 buildLiteRows 统一规则重建）。 */
const visibleRows = computed(() => buildLiteRows(visibleNodes.value))
/** 事件类节点与轮末响应在正文行内展示正文内容（工具/中间思考节点不展示正文）。 */
function showsRowContent(node: LiteRunNode): boolean {
  return isStandaloneNodeKind(node.kind) || node.isRoundFinal
}

// ── v0.5 链路标签栏：正文列表顶部常驻，主 Agent ✧ + 各子 Agent ◆ 角色名，激活高亮、点击切换 activeLane，
// 与轨迹行头角色名按钮联动（链路展示改造：切换入口从轨迹行头移到正文顶部，直观可见）。 ──
interface LaneTab {
  chatId: string
  label: string
  isRootLane: boolean
}
const laneTabs = computed<LaneTab[]>(() => {
  const seen = new Set<string>()
  const rootTabs: LaneTab[] = []
  const childTabs: LaneTab[] = []
  for (const node of history.value.nodes) {
    const laneId = laneIdOf(node)
    if (seen.has(laneId)) continue
    seen.add(laneId)
    const tab: LaneTab = {
      chatId: laneId,
      label: node.agentLabel || (laneId === props.rootChatId ? '主 Agent' : '子 Agent'),
      isRootLane: laneId === props.rootChatId,
    }
    if (tab.isRootLane) rootTabs.push(tab)
    else childTabs.push(tab)
  }
  // 主 Agent 链路固定最前，子 Agent 按出现顺序。
  return [...rootTabs, ...childTabs]
})

// ── v0.5 子 Agent 入口消息：主 Agent 派发给该子 Agent 的任务（dispatch 节点 content），
// 取最早一条 targetChatId = activeLane 的委派节点，正文列表顶部独立块展示。 ──
const entryDispatch = computed<LiteRunNode | null>(() => {
  if (activeLane.value === props.rootChatId) return null
  const candidates = history.value.nodes.filter(
    (node) => node.kind === 'dispatch' && node.targetChatId === activeLane.value,
  )
  if (!candidates.length) return null
  return (
    [...candidates].sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key))[0] ??
    null
  )
})
const entryExpanded = ref(false)
/** 入口消息全文预览：默认截断 ≤120 字，展开显示全文。 */
const entryPreview = computed(() => {
  const content = entryDispatch.value?.content ?? ''
  if (entryExpanded.value) return content
  return content.length > 120 ? content.slice(0, 120) + '…' : content
})
const entryHasMore = computed(() => {
  const content = entryDispatch.value?.content ?? ''
  return !entryExpanded.value && content.length > 120
})

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
    if (sent) {
      inputText.value = ''
      // v0.4.2 多行输入：清空后等 DOM 更新，把 textarea 高度重置回单行
      await nextTick()
      autoGrowInput()
    }
  } finally {
    sending.value = false
  }
}

/**
 * 回车发送（v0.4.2 多行输入框）：Enter 直接发送、Shift+Enter 换行（textarea 默认插入换行，不做 preventDefault）；
 * 中文输入法组合确认（isComposing / keyCode 229）时不触发，避免误发。
 */
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
  if (event.shiftKey) return
  event.preventDefault()
  void onSend()
}

/** v0.4.2：多行自适应增高——默认单行（rows=1），换行/长内容时按 scrollHeight 自动撑高，上限内滚动。 */
function autoGrowInput(): void {
  const el = liteInputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
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
  /** 页签图标（v0.4.2：审批=工具 icon，提问=❓） */
  icon: string
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
        icon: lite.toolMeta(senseName)?.icon?.trim() || '⚙',
        countdown: remainingLabel(interaction),
        expired: remainingLabel(interaction) === '已超时',
      }
    }
    const count = questionsOf(interaction).length
    return {
      id: interaction.interactionId,
      kind: 'question' as const,
      label: count > 1 ? '提问 ' + count + ' 问' : '提问',
      icon: '❓',
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
const liteInputEl = ref<HTMLTextAreaElement | null>(null)
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
  const rows = visibleRows.value
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
/** t14 定位：把 focusNodeId 对应内容行滚入 monitor 可视区并高亮。
    异步：切换链路后需等 DOM 渲染出新行（rowEls 注册完成）再滚动定位。 */
async function locateNode(nodeId: string): Promise<void> {
  focusNodeId.value = nodeId
  await nextTick()
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
function focusNodeFromTrajectory(node: LiteRunNode): void {
  // 点击轨迹块：先切到该块所在链路（正文列表按链路过滤），再定位高亮对应内容。
  activeLane.value = laneIdOf(node)
  void locateNode(node.nodeId)
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
  if (node.kind === 'tool') return `${toolTypeEmoji(node.toolType)} ${LITE_NODE_LABELS.tool}`
  return LITE_NODE_LABELS[node.kind]
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
  if (nodeId) void locateNode(nodeId)
}

// t15：运行时长分级（运行时间变色）——快/中/久三档，用块边框颜色表达。
function durationTier(elapsedMs: number): 'fast' | 'medium' | 'long' | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null
  const seconds = elapsedMs / 1000
  if (seconds < 10) return 'fast'
  if (seconds < 30) return 'medium'
  return 'long'
}

// ── 时间瀑布流（v3 共享压缩时间轴）──
// 所有链路共享一条全局时间轴：节点按 startedAt 绝对定位（需求 3/6：不是每条链路从头画起），
// 同一时间轴上大段等待被压缩（封顶 MAX_GAP_PX），执行时长差异保留可见性。
// 执行节点（工具 / 主·子 Agent 响应）宽 = 真实执行耗时秒数 × 1px，两档上限：
//   · 正常档（空间足够）：1s=1px，超过 180s 封顶 180px（MAX_BAR_PX）；
//   · 压缩档（一行放不下）：整体挤压，clamp 到 [MIN_BAR_PX, COMPRESSED_MAX_BAR_PX]。
// 事件节点（用户提问 / 结果返回 / 任务委派 / 协作节点 / 系统）固定窄宽。
/** 执行块宽下限（px）：保证可点击命中（10s 节点 ≥ 10px，即 1px/秒 的下限）。 */
const MIN_BAR_PX = 10
/** 正常档执行块宽上限（px）：空间足够时 1s=1px，超过 180s 封顶 180px。 */
const MAX_BAR_PX = 180
/** 压缩档执行块宽上限（px）：一行放不下时整体挤压，块宽 clamp 到 [MIN_BAR_PX, 30]。 */
const COMPRESSED_MAX_BAR_PX = 30
/** 执行节点线性比例（px/秒）：1 秒 = 1 像素。 */
const MODEL_PX_PER_SEC = 1
/** 相邻节点等待间隔上限（px）：真实空闲 > 此值按此封顶，剔除大段等待（等审批/隔几天）。 */
const MAX_GAP_PX = 24
/** 事件节点固定宽度（px）：结果返回 / 委派 / 协作 / 系统。 */
const EVENT_FIXED_PX = 12
/** 用户提问固定宽度（px）：比普通事件稍宽，突出每轮发起。 */
const USER_FIXED_PX = 16
/** 行头角色名 gutter 宽度（px）：块从此偏移开始排布，避开行头角色名标签；与 CSS .lite-trajectory-lane-label 宽度保持一致。 */
const LABEL_GUTTER_PX = 76

interface TrajectoryBar {
  node: LiteRunNode
  left: number
  width: number
}
interface TrajectoryTrack {
  chatId: string
  label: string
  isRootLane: boolean
  firstStartedAt: number
  bars: TrajectoryBar[]
}
interface TrajectoryLayout {
  tracks: TrajectoryTrack[]
  trackWidth: number
}
/** 执行节点宽 = 真实执行耗时线性映射并 clamp（maxPx 为当前档上限）；事件节点固定宽度。 */
function barWidthFor(node: LiteRunNode, zoom: number, maxPx = MAX_BAR_PX): number {
  if (isTimedNodeKind(node.kind)) {
    const seconds = Math.max(0, node.elapsedMs) / 1000
    const base = seconds * MODEL_PX_PER_SEC
    return Math.max(MIN_BAR_PX, Math.min(maxPx, base * zoom))
  }
  const fixed = node.kind === 'user' ? USER_FIXED_PX : EVENT_FIXED_PX
  // 事件节点固定宽 × zoom 同样 clamp 下限 10（缩放 0.4x 时不窄于 10px，保证可点击命中）。
  return Math.max(MIN_BAR_PX, fixed * zoom)
}

/** 相邻节点时间间隔（px）：真实空闲 × 1px，封顶 MAX_GAP_PX，剔除大段等待。 */
function gapPxBetweenTimes(prevStartedAt: number, nextStartedAt: number, zoom: number): number {
  const gapMs = Math.max(0, nextStartedAt - prevStartedAt)
  return Math.min((gapMs / 1000) * MODEL_PX_PER_SEC, MAX_GAP_PX) * zoom
}

/** v3：轨迹布局 memo——签名 = zoom + 视口宽 + 各节点 [key/kind/status/sourceChatId/startedAt/agentLabel]，
    并纳入**运行中节点**的 elapsedMs：运行中块宽随 elapsedMs 逐秒增长（需求 3.1 先创建→变长→结束固定），
    每秒时钟 tick 仅重算含运行中节点的布局；已终态节点不触发重算。 */
let trajectoryLayoutMemoKey = ''
let trajectoryLayoutMemoValue: TrajectoryLayout | null = null
function trajectoryLayout(width: number, zoom = 1): TrajectoryLayout {
  const nodes = history.value.nodes
  if (!nodes.length) {
    return { tracks: [], trackWidth: 0 }
  }
  let sig = String(zoom) + '|' + String(width) + '|'
  for (const n of nodes) {
    sig += `${n.key}:${n.kind}:${n.status}:${n.sourceChatId}:${n.startedAt}:${n.agentLabel}`
    if (n.active) sig += `:${n.elapsedMs}`
    sig += ';'
  }
  if (trajectoryLayoutMemoValue && trajectoryLayoutMemoKey === sig) {
    return trajectoryLayoutMemoValue
  }
  trajectoryLayoutMemoKey = sig
  trajectoryLayoutMemoValue = computeTrajectoryLayout(nodes, width, zoom, props.rootChatId)
  return trajectoryLayoutMemoValue
}

/** v3：bar 内联样式——纯 left/width 定位（运行中块宽由 elapsedMs 驱动的布局重算推进，不再用 CSS 动画）。 */
function trajectoryBarStyle(bar: TrajectoryBar): CSSProperties {
  return { left: bar.left + 'px', width: bar.width + 'px' }
}

function computeTrajectoryLayout(
  nodes: LiteRunNode[],
  width: number,
  zoom: number,
  rootChatId: string,
): TrajectoryLayout {
  // 需求 5：用户消息并入主 Agent 链路（用户消息发给主 Agent）；其余按归属 Agent（sourceChatId）分链路。
  const laneIdOf = (node: LiteRunNode): string =>
    node.kind === 'user' ? rootChatId : node.sourceChatId

  // 需求 3/6：全局共享压缩时间轴——所有节点按 startedAt 绝对定位，而非每条链路从头画起。
  // 逐个全局事件累加压缩间隔，得到每个节点在时间轴上的 X 坐标（大段等待被封顶剔除）。
  const sorted = [...nodes].sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key))
  const xByKey = new Map<string, number>()
  let cursor = LABEL_GUTTER_PX
  let prevStartedAt: number | null = null
  for (const node of sorted) {
    if (prevStartedAt !== null) cursor += gapPxBetweenTimes(prevStartedAt, node.startedAt, zoom)
    xByKey.set(node.key, cursor)
    prevStartedAt = node.startedAt
  }

  const byLane = new Map<string, LiteRunNode[]>()
  for (const node of nodes) {
    const laneId = laneIdOf(node)
    const list = byLane.get(laneId)
    if (list) list.push(node)
    else byLane.set(laneId, [node])
  }

  // 按给定上限档位排布各链路块，并返回整条时间轴的右边界（决定是否溢出）。
  const buildTracks = (
    maxPx: number,
  ): { tracks: TrajectoryTrack[]; contentWidth: number; compactWidth: number } => {
    const tracks: TrajectoryTrack[] = []
    let contentWidth = 0
    let compactWidth = 0
    for (const [laneId, list] of byLane) {
      const laneSorted = [...list].sort(
        (a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key),
      )
      // v0.5.2：序列化推进——left 取「时间 gap 位置」与「前一块右缘 + 1px」的较大者，
      // 线性流程同一轨道内块间最低 1px 间隔、绝不互相遮挡（gap 增量上限 24px 远小于
      // 块宽上限 180px，纯时间定位下长耗时块必然压住后续块）；时间 gap 在块不挤时仍占位。
      const bars: TrajectoryBar[] = []
      let laneRight = LABEL_GUTTER_PX - 1
      for (const node of laneSorted) {
        const timeX = xByKey.get(node.key) ?? LABEL_GUTTER_PX
        const width = barWidthFor(node, zoom, maxPx)
        const left = Math.max(timeX, laneRight + 1)
        bars.push({ node, left, width })
        laneRight = left + width
      }
      const label = laneSorted[0]?.agentLabel || (laneId === rootChatId ? '主 Agent' : '子 Agent')
      const firstStartedAt = laneSorted[0]?.startedAt ?? 0
      // 实际内容宽（含时间 gap 占位）：决定容器宽（超视口配横向滚动条），不参与挤压判定。
      const laneWidth = bars.reduce((max, bar) => Math.max(max, bar.left + bar.width), 0)
      contentWidth = Math.max(contentWidth, laneWidth)
      // 紧凑口径宽（块固有宽之和 + 1px 间隙，排除时间 gap 占位）：决定是否切换挤压档——
      // 挤压只由「块排不排得下」触发（挤压后执行节点封顶 30px），时间空隙不撑爆宽度、
      // 不误伤空间足够的 180px 正常档。
      const laneCompact =
        LABEL_GUTTER_PX +
        bars.reduce((sum, bar) => sum + bar.width, 0) +
        Math.max(0, bars.length - 1)
      compactWidth = Math.max(compactWidth, laneCompact)
      tracks.push({
        chatId: laneId,
        label,
        isRootLane: laneId === rootChatId,
        firstStartedAt,
        bars,
      })
    }
    // 需求 2：上下链路之间按发起时间线性排序（最早发起自然靠上）。
    tracks.sort((a, b) => a.firstStartedAt - b.firstStartedAt || a.chatId.localeCompare(b.chatId))
    return { tracks, contentWidth, compactWidth }
  }

  // 需求（本次）：空间足够 → 1s=1px（封顶 180px）；一行放不下 → 整体挤压到 [10, 30]。
  // 先用正常档排布，若紧凑口径内容宽度超出视口（width），改用压缩档重排。
  let { tracks, contentWidth, compactWidth } = buildTracks(MAX_BAR_PX)
  if (compactWidth > width) {
    ;({ tracks, contentWidth, compactWidth } = buildTracks(COMPRESSED_MAX_BAR_PX))
  }
  return { tracks, trackWidth: Math.max(width, contentWidth) }
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
      <section
        v-if="history.nodes.length"
        class="lite-trajectory"
        aria-label="运行轨迹时间线"
        @wheel.capture="onTrajectoryWheel"
        @keydown="onTrajectoryKeydown"
      >
        <span v-if="trajectoryZoom !== 1" class="lite-trajectory-head">
          <button
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
            <!-- 单元素 v-for 缓存 layout，避免重复计算轨迹布局 -->
            <template
              v-for="(layout, index) in [trajectoryLayout(width, trajectoryZoom)]"
              :key="index"
            >
              <div class="lite-trajectory-track" :style="{ width: layout.trackWidth + 'px' }">
                <div
                  v-for="track in layout.tracks"
                  :key="track.chatId"
                  class="lite-trajectory-lane"
                  :class="{
                    'is-root-lane': track.isRootLane,
                    'is-active': track.chatId === activeLane,
                  }"
                >
                  <button
                    type="button"
                    class="lite-trajectory-lane-label"
                    :title="'切换到 ' + track.label + ' 链路'"
                    @click="activeLane = track.chatId"
                  >
                    {{ track.label }}
                  </button>
                  <div class="lite-trajectory-lane-track">
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
                      :style="trajectoryBarStyle(bar)"
                      :title="
                        bar.node.label +
                        ' · ' +
                        runStatusLabel(bar.node.status) +
                        ' · 点击定位下方内容'
                      "
                      @pointerenter="showBarTip(bar.node, $event)"
                      @pointermove="moveBarTip"
                      @pointerleave="hideBarTip"
                      @click="focusNodeFromTrajectory(bar.node)"
                    />
                  </div>
                </div>
              </div>
            </template>
          </template>
        </LiteScrollbar>
      </section>

      <nav v-if="laneTabs.length > 1" class="lite-lane-bar" aria-label="切换链路">
        <button
          v-for="tab in laneTabs"
          :key="tab.chatId"
          type="button"
          class="lite-lane-tab"
          :class="[
            { 'is-active': tab.chatId === activeLane },
            { 'is-root-lane': tab.isRootLane },
          ]"
          :title="'切换到 ' + tab.label + ' 链路'"
          @click="activeLane = tab.chatId"
        >
          <span class="lite-lane-tab-icon" aria-hidden="true">{{ tab.isRootLane ? '✧' : '◆' }}</span>
          <span class="lite-lane-tab-label">{{ tab.label }}</span>
        </button>
      </nav>

      <main ref="monitorEl" class="lite-monitor" aria-label="执行监控" @scroll="onMonitorScroll">
        <div v-if="entryDispatch" class="lite-entry-dispatch">
          <div class="lite-entry-dispatch-head">
            <span class="lite-entry-dispatch-icon" aria-hidden="true">{{ entryDispatch.icon }}</span>
            <span class="lite-entry-dispatch-actor">{{ entryDispatch.agentLabel }}</span>
            <span class="lite-entry-dispatch-verb">任务委派</span>
            <button
              v-if="entryHasMore"
              type="button"
              class="lite-entry-dispatch-toggle"
              @click="entryExpanded = !entryExpanded"
            >
              {{ entryExpanded ? '收起' : '展开全文' }}
            </button>
          </div>
          <p class="lite-entry-dispatch-content">{{ entryPreview }}</p>
        </div>
        <ol v-if="visibleRows.length" class="lite-history">
          <li
            v-for="row in visibleRows"
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
              <p v-if="showsRowContent(row.node)" class="lite-history-content">
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

      <section v-if="activeInteraction" class="lite-pending-panel" aria-label="待处理详情">
        <div v-if="pendingTabs.length" class="lite-pending-tabs-bar" role="tablist">
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
            :title="tab.label"
            @click="pendingTab = tab.id"
          >
            <span class="lite-pending-tab-icon" aria-hidden="true">{{ tab.icon }}</span>
            <span class="lite-pending-tab-label">{{ tab.label }}</span>
            <span v-if="tab.countdown" class="lite-pending-badge" :data-expired="tab.expired">
              {{ tab.countdown }}
            </span>
          </button>
        </div>
        <div class="lite-pending-content">
          <div
            v-if="activeInteraction.kind === 'approval'"
            class="lite-interaction"
            :data-status="activeInteraction.status"
          >
          <div class="lite-interaction-head">
            <!-- v0.4.2 双层标题去除：名称由上方页签承载，这里只保留状态与倒计时（靠左展示） -->
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
            <!-- v0.4.2 双层标题去除：名称由上方页签承载，这里只保留状态与倒计时（靠左展示） -->
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
        </div>
      </section>

      <div class="lite-input">
        <textarea
          ref="liteInputEl"
          v-model="inputText"
          class="lite-input-box"
          rows="1"
          :placeholder="
            connectionBlocked ? operationBlockReason : '发送消息（Enter 发送 / Shift+Enter 换行）'
          "
          :disabled="sending || connectionBlocked"
          @keydown="onInputKeydown"
          @input="autoGrowInput"
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
  /* 字重基线 400（用户强制规则）：lite 全部内容继承 400，杜绝任何加粗继承。 */
  font-weight: 400;
}

/* 字重收敛：lite 视图内 <strong>（审批标题/历史 label 等）一律 400——lite 为轻量界面，
   遵循 font-style-guide「内容字段不加粗」，标题层级亦随轻量风格降为 400。 */
.lite-view strong {
  font-weight: 400;
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

/* ── 时间瀑布流（v3 共享压缩时间轴：多轨多 Agent，节点按绝对时间定位、大段等待压缩）── */
.lite-trajectory {
  position: relative;
  flex: none;
  /* v3：轨迹区块高度随内容自适应（不固定、不居中大留白）——任务条多轨时自然变高；
     max-height 仅作多轨溢出的兜底滚动上限。运行中块宽由 elapsedMs 驱动的布局重算逐秒增长。 */
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  max-height: 168px;
  overflow-y: auto;
  scrollbar-width: none;
}
/* 头部为常规文档流行，仅缩放重置按钮（v0.3.2：去掉「时间轴」标题；zoom=1 时不渲染）——不悬浮、不覆盖行标记。 */
.lite-trajectory-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  line-height: 1;
  color: var(--el-text-color-secondary);
  padding: 0 2px 4px;
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
.lite-trajectory::-webkit-scrollbar {
  display: none;
}
.lite-trajectory-track {
  position: relative;
  /* v0.4.2：轨道组紧凑排列——高度=内容高度（随轨数自适应），gap 3px 控制链路间距（需求：2-4px）； */
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 100%;
}
.lite-trajectory-lane {
  position: relative;
  flex: none;
  height: 13px;
  line-height: 0;
}
/* 行头角色名（需求 c/2/4）：独立分配空间展示，实心背景盖住横向滚动时滚过的块，不与节点重叠/冲突；
   本身是按钮，点击切换正文列表显示该链路（需求 4）。 */
.lite-trajectory-lane-label {
  position: sticky;
  left: 0;
  z-index: 4;
  display: inline-block;
  box-sizing: border-box;
  width: 76px;
  height: 13px;
  line-height: 13px;
  padding: 0 8px 0 0;
  border: none;
  border-radius: 0;
  font-family: inherit;
  font-size: 10.5px;
  color: var(--el-text-color-secondary);
  background: var(--el-bg-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.lite-trajectory-lane-label:hover {
  color: var(--el-color-primary);
}
.lite-trajectory-lane.is-root-lane .lite-trajectory-lane-label {
  color: var(--el-color-primary);
}
.lite-trajectory-lane.is-active .lite-trajectory-lane-label {
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 14%, var(--el-bg-color));
}
.lite-trajectory-lane-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 13px;
}
/* 块为标准矩形：无圆角、无虚线等待块——等待区间 = 缺口，由块间空余空间自然呈现 */
.lite-trajectory-bar {
  position: absolute;
  top: 0;
  height: 13px;
  border: none;
  border-radius: 0;
  padding: 0;
  cursor: pointer;
  opacity: 0.72;
  transition:
    opacity 120ms ease,
    box-shadow 120ms ease,
    transform 120ms ease;
}
/* t16：hover 提示（不再放大，避免遮挡上下链路；用 inset 描边高亮，不溢出遮挡两侧块） */
.lite-trajectory-bar:hover {
  opacity: 1;
  box-shadow: inset 0 0 0 1px var(--el-text-color-primary);
}
.lite-trajectory-bar.is-user {
  background: var(--el-color-primary);
}
.lite-trajectory-bar.is-root-agent {
  background: var(--el-color-success);
}
.lite-trajectory-bar.is-child-agent {
  background: #ed79bd;
}
.lite-trajectory-bar.is-tool {
  background: var(--el-color-warning);
}
.lite-trajectory-bar.is-return {
  background: #3ddc97;
}
.lite-trajectory-bar.is-dispatch {
  background: #c58af9;
}
.lite-trajectory-bar.is-spawn {
  background: #c58af9;
}
.lite-trajectory-bar.is-system {
  background: #a99df6;
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
/* v0.4.1：运行中块移除脉冲闪烁动画——宽度随执行时间持续增长即为运行反馈（barWidthFor 线性映射），
   仅保留常亮高亮（opacity:1）。 */
.lite-trajectory-bar.is-running {
  opacity: 1;
}
/* v3：运行中执行块宽度由 elapsedMs 驱动的布局重算逐秒增长（需求 3.1 先创建→变长→结束固定），
   不再使用 CSS 动画（trajectoryLayout memo 已纳入 active.elapsedMs）。 */
.lite-trajectory-bar.is-selected {
  box-shadow: inset 0 0 0 2px var(--el-text-color-primary);
  opacity: 1;
}
/* 无时间刻度轴（v0.3.2：时间跨度展示被放弃，改为紧凑块流） */

/* ── 运行历史列表（需求 1c / 4a）：用户消息与轮末响应独占一行，中间节点为 cluster 小按钮 ── */
/* ── 链路标签栏（v0.5 链路展示改造）：正文列表顶部常驻（monitor 上方、固定不滚动），
   主 Agent ✧ + 各子 Agent ◆ 角色名，激活高亮、点击切换 activeLane，与轨迹行头角色名按钮联动；
   直角矩形（用户强制规则：无圆角）── */
.lite-lane-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.lite-lane-bar::-webkit-scrollbar {
  display: none;
}
.lite-lane-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  padding: 3px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
}
.lite-lane-tab:hover:not(.is-active) {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}
.lite-lane-tab.is-active {
  background: color-mix(in srgb, var(--el-color-primary) 12%, var(--el-bg-color));
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.lite-lane-tab-icon {
  flex: none;
  font-size: 11px;
  line-height: 1;
}
.lite-lane-tab.is-root-lane .lite-lane-tab-icon {
  color: var(--el-color-primary);
}
.lite-lane-tab-label {
  min-width: 0;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 子 Agent 入口消息块（v0.5 链路展示改造）：主 Agent 派发给该子 Agent 的任务说明，
   独立于历史列表（不进时间轴/轮次排序），打开子 Agent 链路即可看到其任务 ── */
.lite-entry-dispatch {
  border: 1px solid color-mix(in srgb, #c58af9 55%, var(--el-border-color));
  border-radius: 8px;
  background: color-mix(in srgb, #c58af9 7%, var(--el-bg-color));
  overflow: hidden;
}
.lite-entry-dispatch-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
}
.lite-entry-dispatch-icon {
  flex: none;
  width: 18px;
  text-align: center;
  color: #c58af9;
}
.lite-entry-dispatch-actor {
  color: var(--el-text-color-primary);
}
.lite-entry-dispatch-verb {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.lite-entry-dispatch-toggle {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--el-color-primary);
  font-size: 12px;
  cursor: pointer;
}
.lite-entry-dispatch-content {
  margin: 0;
  padding: 0 10px 8px 34px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  /* 强制字重规则：正文一律 400。 */
  font-weight: 400;
}

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
.lite-history-row.is-root-agent .lite-history-icon {
  color: var(--el-color-success);
}
.lite-history-row.is-child-agent .lite-history-icon {
  color: #ed79bd;
}
.lite-history-row.is-return .lite-history-icon {
  color: #3ddc97;
}
.lite-history-row.is-dispatch .lite-history-icon,
.lite-history-row.is-spawn .lite-history-icon {
  color: #c58af9;
}
.lite-history-row.is-system .lite-history-icon {
  color: #a99df6;
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
  /* 强制字重规则：内容/标签一律 400，不随 <strong> 默认加粗。 */
  font-weight: 400;
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
  /* 强制字重规则：用户提问/模型响应正文一律 400。 */
  font-weight: 400;
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
  box-shadow: inset 0 0 0 2px var(--el-color-primary);
  opacity: 1;
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
.lite-tip-head strong {
  font-weight: 400;
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

/* ── 待操作页签（v0.4.2 浏览器式）：标签栏内多 tab，样式照抄浏览器顶部 tab——
   上圆角下直角、底部与内容区连接（无底边框）；激活 tab 亮背景（= 内容区背景，与其连体）
   + 主色边框文字 + 略高盖过非激活；非激活 tab 透明背景（= 标签栏灰）+ 略矮；
   激活不收缩，其余空间不足时互相挤压、最短只剩 icon ── */
.lite-pending-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 160px;
  /* 非激活 tab 底部 padding 更薄 → 总高矮于激活 tab（底部对齐后顶部低 4px，浏览器 tab 层次） */
  padding: 6px 14px 5px;
  /* 浏览器 tab：直角矩形（用户强制规则：无圆角）、底部与内容区连接（无底边框） */
  border: 1px solid var(--el-border-color);
  border-bottom: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease,
    color 120ms ease;
  /* 标签挤压：不撑满（flex-grow 0），空间不足时非激活可收缩（flex-shrink 1） */
  flex: 0 1 auto;
}
.lite-pending-tab:hover:not(.is-active) {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}
.lite-pending-tab.is-active {
  /* 当前展示页签不挤压 */
  flex: 0 0 auto;
  /* 激活 tab：底部 padding 更厚 → 更高盖过非激活；亮背景与内容区同色连体、主色边框与文字 */
  padding: 6px 14px 9px;
  background: var(--el-bg-color);
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.lite-pending-tab-icon {
  flex: none;
  font-size: 12px;
  line-height: 1;
}
.lite-pending-tab-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lite-pending-badge {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  padding: 0 5px;
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
/* ── 待处理详情面板（v0.4.2 浏览器式多 tab）：独立卡片（直角边框，无圆角——用户强制规则）与上方对话流区分；
   卡内两级结构——标签栏（灰背景）+ 内容区（亮背景）；激活 tab 亮背景与内容区同色连体、
   底部直通内容区无分隔（切换 tab 内容随之切换）── */
.lite-pending-panel {
  flex: none;
  display: flex;
  flex-direction: column;
  max-height: 36%;
  margin: 4px 10px 0;
  border: 1px solid var(--el-border-color-lighter);
  overflow: hidden;
}
/* 标签栏：灰背景（浏览器 tab 栏），页签靠左排、不撑满、右侧留白 */
.lite-pending-tabs-bar {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 4px;
  padding: 6px 12px 0;
  background: var(--el-fill-color-lighter);
  overflow: hidden;
}
/* 内容区：亮背景卡片，激活 tab 底部与此同色连体 */
.lite-pending-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px;
  background: var(--el-bg-color);
  scrollbar-width: none;
}
.lite-pending-content::-webkit-scrollbar {
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
  /* v0.4.2 去掉内容区标题后：状态与倒计时靠左展示 */
  justify-content: flex-start;
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
  /* v0.4.2 多行输入：按钮贴底对齐 */
  align-items: flex-end;
  padding: 8px 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.lite-input-box {
  width: 100%;
  box-sizing: border-box;
  /* v0.4.2 多行自适应：默认单行，换行/长内容自动增高（autoGrowInput），上限内滚动 */
  resize: none;
  max-height: 120px;
  padding: 7px 10px;
  border: 1px solid var(--el-border-color);
  background: var(--el-fill-color-blank);
  color: inherit;
  font: inherit;
  line-height: 1.5;
}
.lite-send-btn {
  flex: none;
  margin-left: 8px;
  padding: 6px 16px;
  border: none;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 12.5px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    opacity 120ms ease;
}
.lite-send-btn:hover:not(:disabled) {
  background: var(--el-color-primary-light-3);
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
