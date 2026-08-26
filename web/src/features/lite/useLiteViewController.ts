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
  toolTypeLabel,
  type LiteRunNode,
  type LiteRunNodeStatus,
  type LiteRunRow,
} from './executionMonitor'
import type { LiteDetailSectionName } from './detailSections'
import LiteScrollbar from './LiteScrollbar.vue'
import DetailDrawer from './DetailDrawer.vue'
import LiteMarkdown from './LiteMarkdown.vue'

export type LiteViewControllerProps = { windowId: string; rootChatId: string; presetName?: string }

export function useLiteViewController(props: LiteViewControllerProps) {
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
  /** 用户消息正文为纯文本（不渲染 markdown，避免 # / * 被误解释）；其余（Agent/事件/委派）走 markdown。 */
  function isPlainRowContent(node: LiteRunNode): boolean {
    return node.kind === 'user'
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

  return {
    DetailDrawer, LiteMarkdown, LiteScrollbar, aborting, activeInteraction, activeLane,
    activePendingTabId, answering, approvalDetailNodeId, approvalRiskSummary, autoGrowInput,
    closeDetail, connectionBlocked, deciding, detailNode, detailNodeIndex, durationTier,
    entryDispatch, entryExpanded, entryHasMore, entryPreview, errorBanner, focusNodeFromTrajectory,
    focusNodeId, formatElapsed, hideBarTip, history, hoverNode, hydrationLabel, inputText,
    interactionActionable, interactionStatusLabel, isDetailNode, isInFlightNode, isPlainRowContent,
    isRowFocused, laneTabs, lite, liteInputEl, liteStatus, monitor, monitorEl, moveBarTip,
    nodeKindLabel, noteOf, onAnswerBatch, onDecide, onErrorAction, onInputKeydown, onMonitorScroll,
    onResume, onSend, onStop, onTrajectoryKeydown, onTrajectoryWheel, openApprovalDetail,
    openNodeDetail, operationBlockReason, pendingTab, pendingTabs, questionsOf, ref, remainingLabel,
    resetTrajectoryZoom, resuming, rootUi, rowKey, runStatusLabel, selectedOf, sending,
    setOptionNote, setRowEl, setTextDraft, showBarTip, showsRowContent, textDraftOf, tipPos,
    toggleOption, toolTypeLabel, trajectoryBarStyle, trajectoryLayout, trajectoryZoom, visibleRows,
  }
}
