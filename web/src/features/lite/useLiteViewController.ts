import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import { useLiteStore } from './liteStore'
import { useLiteCanonicalView } from './useLiteCanonicalView'
import { useLiteInteractions } from './useLiteInteractions'
import {
  splitCommandPrompt,
  type CommandPromptSegment,
} from '@/features/agent/composables/commands'
import {
  buildLiteRows,
  classifyToolType,
  createLiteExecutionClock,
  formatElapsed,
  isStandaloneNodeKind,
  isTimedNodeKind,
  LITE_NODE_LABELS,
  projectLiteExecution,
  projectLiteHistory,
  toolTypeGlyph,
  toolTypeLabel,
  type LiteRunNode,
  type LiteRunNodeStatus,
  type LiteRunRow,
  type LiteToolCallItem,
} from './executionMonitor'
import type { LiteDetailSectionName } from './detailSections'
import LiteScrollbar from './LiteScrollbar.vue'
import DetailDrawer from './DetailDrawer.vue'
import LiteMarkdown from './LiteMarkdown.vue'
import { useLiteNodeTones } from './useLiteNodeTones'
import {
  agentApi,
  type ConfigDto,
  type GraphToolCall,
  type MediaCapabilitiesDto,
} from '@/application/backend/public'
import { useChatSessionsStore } from '@/application/public'
import type { UploadFile } from 'element-plus'
import type { MediaAttachment, MediaKind } from '@/features/agent/composer/useAgentDialogOptions'
import {
  compressImage,
  COMPRESS_MAX_EDGE,
  COMPRESS_QUALITY,
  loadImageDims,
  mediaKindOf,
  ORIGINAL_MAX_EDGE,
  ORIGINAL_QUALITY,
  shouldCompressImage,
} from '@/utils/imageCompress'

export type LiteViewControllerProps = { windowId: string; rootChatId: string; presetName?: string }

export function useLiteViewController(props: LiteViewControllerProps) {
  const liteUi = useLiteStore()
  const chatSessions = useChatSessionsStore()
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
  /** 交互单一事实源（审批/提问展示与操作，供详情抽屉消费；铃铛定位也走这里）。 */
  const interactions = useLiteInteractions(
    () => props.windowId,
    () => props.rootChatId,
  )
  /** 节点色调（与节点树 nodeSkins 同源，随主题切换）：以 CSS 变量绑定 .lite-view 根元素。 */
  const { nodeToneVars } = useLiteNodeTones()
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
  /** 用户指令性消息正文拆分（v2.8）：[[command:…]] / [[role:@…]] token 渲染为样式化标签，
      与对话模式 MessageBubble 同源（splitCommandPrompt）；普通文本原样保留（含换行）。 */
  function userSegments(node: LiteRunNode): CommandPromptSegment[] {
    return splitCommandPrompt(node.content || '')
  }
  /** 正文行内「思考」折叠态（v2.8）：按节点 key 独立记录，默认收起；点击标题展开/收起。 */
  const thinkingOpenKeys = ref(new Set<string>())
  function isThinkingOpen(node: LiteRunNode): boolean {
    return thinkingOpenKeys.value.has(node.key)
  }
  function toggleThinking(node: LiteRunNode): void {
    const next = new Set(thinkingOpenKeys.value)
    if (next.has(node.key)) next.delete(node.key)
    else next.add(node.key)
    thinkingOpenKeys.value = next
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
  /** 工具调用状态 → 节点状态（cluster 组内逐工具状态线 / 文案映射）。 */
  function toolCallStatus(status: GraphToolCall['status']): LiteRunNodeStatus {
    switch (status) {
      case 'pending':
      case 'accepted':
        return 'running'
      case 'completed':
        return 'completed'
      case 'error':
        return 'failed'
      case 'rejected':
        return 'rejected'
    }
  }
  const monitorEl = ref<HTMLElement | null>(null)
  const autoScroll = computed({
    get: () => rootUi.value.autoScroll,
    set: (value: boolean) =>
      liteUi.patchRootUi(props.windowId, props.rootChatId, { autoScroll: value }),
  })
  /** v1.2：scrollTop 回写节流（rAF）——原实现每个 scroll 事件都整包替换 rootUi，
      滚动期间持续触发全视图重渲染，与自动滚动互相打架。 */
  let scrollTopPatchQueued = false
  function queueScrollTopPatch(): void {
    if (scrollTopPatchQueued) return
    scrollTopPatchQueued = true
    requestAnimationFrame(() => {
      scrollTopPatchQueued = false
      const element = monitorEl.value
      if (!element) return
      liteUi.patchRootUi(props.windowId, props.rootChatId, { scrollTop: element.scrollTop })
    })
  }
  function onMonitorScroll(): void {
    const element = monitorEl.value
    if (!element) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40
    // 仅在越过边界时写回，避免每次滚动帧都触发 store 替换。
    if (autoScroll.value !== atBottom) autoScroll.value = atBottom
    queueScrollTopPatch()
  }
  /** v1.2：内容塌陷防护——运行中投影重建使列表短暂清空时，滚动容器高度塌为 0、
      scrollTop 被浏览器钳到 0（「滚到底突然闪回顶部、像无限滚动」的根源）；
      行恢复后若用户没有主动回到顶部，则还原塌陷前记录的位置。 */
  let collapsedScrollTop: number | null = null
  watch(
    () => visibleRows.value.length,
    async (length, previous) => {
      if (previous && previous > 0 && length === 0) {
        collapsedScrollTop = monitorEl.value?.scrollTop ?? rootUi.value.scrollTop
        return
      }
      if (previous === 0 && length > 0 && collapsedScrollTop !== null) {
        const restore = collapsedScrollTop
        collapsedScrollTop = null
        if (restore > 0) {
          await nextTick()
          const element = monitorEl.value
          if (element && element.scrollTop <= 1) element.scrollTop = restore
        }
      }
    },
  )
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
    // 媒体附件：可压缩图片按 useCompressed 选择发送「压缩版」还是「原图版（基本压缩）」
    const attachments = mediaAttachments.value.map((m) => {
      const chosen = m.useCompressed && m.compressed ? m.compressed : m
      return { assetId: chosen.assetId, kind: m.kind, mimeType: chosen.mimeType }
    })
    sending.value = true
    try {
      const sent = await lite.submitInput(content, attachments)
      if (sent) {
        // 新运行已开始：清掉可能残留的命令错误 banner（成功发送是新一轮开始）
        lite.lastCommandError = null
        inputText.value = ''
        for (const a of mediaAttachments.value) URL.revokeObjectURL(a.previewUrl)
        mediaAttachments.value = []
        mediaHint.value = ''
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
  /** v0.4.2：多行自适应增高——默认单行（rows=1），换行/长内容时按 scrollHeight 自动撑高，上限内滚动。
   * box-sizing: border-box 下 height 需补上边框高度，否则盒子比内容矮 1px×2，空内容也挤出右侧细滚动条；
   * 展开态有 min-height 撑高盒子，测真实内容行数前先临时解除。 */
  /** 输入框可视行数（含自动换行）：>2 行时组件才显示「展开输入框」按钮（默认隐藏）。 */
  const inputLines = ref(1)
  /** 行数测量缓存（字号/内距静态，首次读取后复用）。 */
  let inputMetrics: { lineHeight: number; padding: number } | null = null
  function autoGrowInput(): void {
    const el = liteInputEl.value
    if (!el) return
    const borders = el.offsetHeight - el.clientHeight
    const minHeight = el.style.minHeight
    el.style.minHeight = '0'
    el.style.height = 'auto'
    const contentHeight = el.scrollHeight
    el.style.height = contentHeight + borders + 'px'
    el.style.minHeight = minHeight
    if (!inputMetrics) {
      const style = window.getComputedStyle(el)
      inputMetrics = {
        lineHeight: Number.parseFloat(style.lineHeight) || 21,
        padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
      }
    }
    inputLines.value = Math.max(
      1,
      Math.round((contentHeight - inputMetrics.padding) / inputMetrics.lineHeight),
    )
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
  // 运行错误条「查看详情」展开态（§4.14）：runError 消失时复位收起。
  const runDetailOpen = ref(false)
  function toggleRunDetail(): void {
    runDetailOpen.value = !runDetailOpen.value
  }
  /** 详情行文案：有 detail 显示上游摘要，否则给 tracingId 日志检索指引（error-conventions 一行内）。 */
  const runDetailText = computed(() => {
    const runError = lite.runError
    if (!runError) return ''
    return runError.detail
      ? `${runError.detail}${runError.tracingId ? `（检索 ${runError.tracingId}）` : ''}`
      : runError.tracingId
        ? `详情见日志，检索 ${runError.tracingId}`
        : ''
  })
  watch(
    () => lite.runError,
    (runError) => {
      if (!runError) runDetailOpen.value = false
    },
  )
  const detailReturnFocus = ref<HTMLElement | null>(null)
  function rememberDetailTrigger(event?: Event): void {
    detailReturnFocus.value =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
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
  /** 工具节点：点击单个工具调用 → 打开详情抽屉并定位到该调用卡。 */
  function openToolCallDetail(node: LiteRunNode, call: LiteToolCallItem, event: Event): void {
    showDetail(node.nodeId, 'toolCalls', call.callId, event)
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
  // 铃铛定位待处理交互（工作台写入 rootUi.attentionOpenRequest）：打开目标交互所在节点的详情抽屉，
  // 并聚焦承载该交互的工具调用卡（审批=interactionId / 提问=第一题 questionId）。消费后清空请求。
  watch(
    () => rootUi.value.attentionOpenRequest,
    (request) => {
      if (!request) return
      const interaction = lite.interactions.find(
        (item) => item.interactionId === request.interactionId,
      )
      if (interaction) {
        const focusCallId = interactions.focusCallIdForInteraction(interaction)
        const nodeId = interactions.focusNodeForInteraction(interaction)
        if (nodeId) showDetail(nodeId, 'toolCalls', focusCallId)
      }
      liteUi.patchRootUi(props.windowId, props.rootChatId, { attentionOpenRequest: null })
    },
  )
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
  // t16：hover 放大 + tip 展示详情（时间轴 bar 悬停浮层）。cluster 小按钮复用同一浮层。
  const hoverNode = ref<LiteRunNode | null>(null)
  /** 悬停单个工具调用时的覆盖信息（cluster 组内工具 icon）；缺省 = 整节点提示。 */
  const hoverCall = ref<LiteToolCallItem | null>(null)
  const tipPos = ref({ x: 0, y: 0 })
  /** 浮层底部「点击」操作提示：轨迹块点击定位下方内容，cluster 小按钮点击查看详情。 */
  const tipAction = ref('')
  function showBarTip(node: LiteRunNode, event: PointerEvent, call?: LiteToolCallItem): void {
    hoverNode.value = node
    hoverCall.value = call ?? null
    tipPos.value.x = event.clientX
    tipPos.value.y = event.clientY
    const target = event.currentTarget
    tipAction.value =
      target instanceof HTMLElement && target.classList.contains('lite-trajectory-bar')
        ? '点击定位下方内容'
        : '点击查看详情'
  }
  function moveBarTip(event: PointerEvent): void {
    if (!hoverNode.value) return
    tipPos.value.x = event.clientX
    tipPos.value.y = event.clientY
  }
  function hideBarTip(): void {
    hoverNode.value = null
    hoverCall.value = null
    tipAction.value = ''
  }
  function nodeKindLabel(node: LiteRunNode): string {
    if (node.kind === 'tool') return `${toolTypeGlyph(node.toolType)} ${LITE_NODE_LABELS.tool}`
    return LITE_NODE_LABELS[node.kind]
  }
  /** 小图标 tip 文案（cluster 小按钮 / 轨迹块 aria-label 共用）：节点类型 + 工具类型 + 名称 + 状态 + 耗时。 */
  function nodeTipText(node: LiteRunNode): string {
    const parts: string[] = [LITE_NODE_LABELS[node.kind]]
    if (node.kind === 'tool' && node.toolType) parts.push(toolTypeLabel(node.toolType))
    parts.push(node.label)
    parts.push(runStatusLabel(node.status))
    if (node.elapsedMs > 0) parts.push(formatElapsed(node.elapsedMs))
    return parts.join(' · ')
  }
  /** cluster 思考/正文标记：主·子 Agent 响应，或工具节点合并了思考/正文时展示。 */
  function showThinkingMark(node: LiteRunNode): boolean {
    if (node.kind === 'root-agent' || node.kind === 'child-agent') return true
    return Boolean(node.thinking) || Boolean(node.content?.trim())
  }
  /** 单个工具调用的 tip 文案（cluster 组内工具 aria-label）：工具 + 类型 + 名称 + 状态 + 耗时。 */
  function toolCallTipText(node: LiteRunNode, call: LiteToolCallItem): string {
    const parts: string[] = [LITE_NODE_LABELS.tool, toolTypeLabel(classifyToolType(call.name))]
    parts.push(call.label)
    parts.push(runStatusLabel(toolCallStatus(call.status)))
    if (node.elapsedMs > 0) parts.push(formatElapsed(node.elapsedMs))
    return parts.join(' · ')
  }
  // t16：MCU 方向键选中（预留）——左右/上下移动时间轴 bar 焦点并同步定位高亮。
  function onTrajectoryKeydown(event: KeyboardEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.classList.contains('lite-trajectory-bar'))
      return
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
    const sorted = [...nodes].sort(
      (a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key),
    )
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

  // ── 媒体（图片/视频/音频）：与对话/树输入区一致的上传-压缩-携带体系。
  //    精简模式是独立 controller，媒体状态与逻辑在此自带；发送时经 onSend 携带附件。 ──
  const config = ref<ConfigDto | null>(null)
  async function ensureConfig(): Promise<ConfigDto | null> {
    if (!config.value) {
      try {
        config.value = await agentApi.getConfig()
      } catch {
        config.value = null
      }
    }
    return config.value
  }
  const mediaAttachments = ref<MediaAttachment[]>([])
  const uploading = ref(false)
  const mediaHint = ref('')
  /** 当前会话主角色 brain（取最近一条带 runtime 的用户/助手消息的发送配置）。 */
  function currentBrain(): string | undefined {
    const session = chatSessions.sessionsById[props.rootChatId]
    if (!session) return undefined
    for (const id of [...session.messageOrder].reverse()) {
      const runtime = session.messagesById[id]?.runtime
      if (runtime?.brain) return runtime.brain
    }
    return undefined
  }
  /** 当前会话主角色 brain 的 input 能力。 */
  function brainCapability(): MediaCapabilitiesDto | undefined {
    const brainName = currentBrain()
    if (!brainName) return undefined
    return config.value?.llm.brain[brainName]?.capabilities?.input
  }
  /** 各媒体类型对应的已启用服务名（媒体菜单显示用；brain 原生能力补位）。 */
  const mediaServicesByType = computed<Record<MediaKind, string | null>>(() => {
    const result: Record<string, string | null> = { image: null, video: null, audio: null }
    for (const [name, svc] of Object.entries(config.value?.media ?? {})) {
      if (svc.enabled && svc.url && !result[svc.type]) result[svc.type] = name
    }
    const capability = brainCapability()
    for (const kind of ['image', 'video', 'audio'] as const) {
      if (!result[kind] && capability?.[kind]) result[kind] = '模型原生支持'
    }
    return result as Record<MediaKind, string | null>
  })
  const mediaDisabledReason = computed(() => {
    if (sending.value) return '消息正在发送'
    if (uploading.value) return '附件正在上传'
    return ''
  })
  function removeMedia(attachment: MediaAttachment): void {
    URL.revokeObjectURL(attachment.previewUrl)
    mediaAttachments.value = mediaAttachments.value.filter((item) => item !== attachment)
    mediaHint.value = mediaAttachments.value.length
      ? `已附加 ${mediaAttachments.value.length} 个媒体文件`
      : ''
  }
  function toggleMediaVariant(attachment: MediaAttachment): void {
    if (!attachment.compressed) return
    const next = { ...attachment, useCompressed: !attachment.useCompressed }
    const index = mediaAttachments.value.indexOf(attachment)
    if (index >= 0) mediaAttachments.value[index] = next
    else mediaAttachments.value = mediaAttachments.value.map((m) => (m === attachment ? next : m))
  }
  async function onMediaSelected(uploadFile: UploadFile): Promise<void> {
    const file = uploadFile.raw
    if (!file || uploading.value || sending.value) return
    await ensureConfig()
    const category = mediaKindOf(file)
    if (!category) return
    const hasMediaService = config.value?.media
      ? Object.values(config.value.media).some(
          (svc) => svc.type === category && svc.enabled && svc.url,
        )
      : false
    const hasBrainCapability = brainCapability()?.[category] === true
    if (!hasMediaService && !hasBrainCapability) {
      const typeLabel = category === 'image' ? '图片' : category === 'video' ? '视频' : '音频'
      mediaHint.value = `未配置${typeLabel}服务，且小组无支持模型`
      return
    }
    uploading.value = true
    mediaHint.value = '上传媒体中…'
    try {
      const previewUrl = URL.createObjectURL(file)
      const dims = category === 'image' ? await loadImageDims(file) : null
      // 图片超阈值 → 上传「原图版(2048/90) + 压缩版(1280/85)」双版本，默认发压缩版
      if (category === 'image' && shouldCompressImage(file, dims)) {
        const [origTier, compTier] = await Promise.all([
          compressImage(file, { maxEdge: ORIGINAL_MAX_EDGE, quality: ORIGINAL_QUALITY }),
          compressImage(file, { maxEdge: COMPRESS_MAX_EDGE, quality: COMPRESS_QUALITY }),
        ])
        if (origTier && compTier) {
          const [origAsset, compAsset] = await Promise.all([
            agentApi.uploadMedia(
              new File([origTier.blob], `original-${file.name}`, { type: origTier.blob.type }),
            ),
            agentApi.uploadMedia(
              new File([compTier.blob], `compressed-${file.name}`, { type: compTier.blob.type }),
            ),
          ])
          mediaAttachments.value.push({
            assetId: origAsset.id,
            filename: origAsset.filename,
            kind: 'image',
            mimeType: origAsset.mimeType,
            size: origAsset.size,
            previewUrl,
            width: origTier.dims.width,
            height: origTier.dims.height,
            useCompressed: true,
            compressed: {
              assetId: compAsset.id,
              filename: compAsset.filename,
              mimeType: compAsset.mimeType,
              size: compAsset.size,
              width: compTier.dims.width,
              height: compTier.dims.height,
            },
          })
          mediaHint.value = `${file.name} 已附加`
          return
        }
      }
      // 小图 / 非图片 / 压缩失败 → 上传原始文件
      const asset = await agentApi.uploadMedia(file)
      const base: MediaAttachment = {
        assetId: asset.id,
        filename: asset.filename,
        kind: asset.kind,
        mimeType: asset.mimeType,
        size: asset.size,
        previewUrl,
        useCompressed: false,
      }
      if (category === 'image' && dims) {
        base.width = dims.width
        base.height = dims.height
      }
      mediaAttachments.value.push(base)
      mediaHint.value = `${file.name} 已附加`
    } catch (err) {
      mediaHint.value = (err as Error).message
    } finally {
      uploading.value = false
    }
  }

  return {
    DetailDrawer,
    LiteMarkdown,
    LiteScrollbar,
    aborting,
    activeLane,
    autoGrowInput,
    closeDetail,
    connectionBlocked,
    detailNode,
    detailNodeIndex,
    entryDispatch,
    entryExpanded,
    entryHasMore,
    entryPreview,
    errorBanner,
    focusNodeFromTrajectory,
    focusNodeId,
    formatElapsed,
    hideBarTip,
    history,
    hoverCall,
    hoverNode,
    hydrationLabel,
    inputText,
    inputLines,
    isDetailNode,
    isPlainRowContent,
    isRowFocused,
    isThinkingOpen,
    laneTabs,
    lite,
    liteInputEl,
    liteStatus,
    monitor,
    monitorEl,
    moveBarTip,
    mediaAttachments,
    mediaDisabledReason,
    mediaHint,
    mediaServicesByType,
    nodeKindLabel,
    nodeTipText,
    nodeToneVars,
    onErrorAction,
    onInputKeydown,
    onMonitorScroll,
    onMediaSelected,
    onResume,
    onSend,
    onStop,
    onTrajectoryKeydown,
    onTrajectoryWheel,
    openNodeDetail,
    openToolCallDetail,
    operationBlockReason,
    removeMedia,
    resetTrajectoryZoom,
    resuming,
    rootUi,
    rowKey,
    runDetailOpen,
    runDetailText,
    runStatusLabel,
    sending,
    setRowEl,
    showBarTip,
    showThinkingMark,
    showsRowContent,
    tipAction,
    tipPos,
    toolCallStatus,
    toolCallTipText,
    toggleMediaVariant,
    toggleThinking,
    toggleRunDetail,
    toolTypeGlyph,
    toolTypeLabel,
    trajectoryBarStyle,
    trajectoryLayout,
    trajectoryZoom,
    uploading,
    userSegments,
    visibleRows,
  }
}
