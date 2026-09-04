import { computed, ref, type ComputedRef } from 'vue'
import type { SettingsSection } from '@/domain/shell/desktopBridge'
import { loadWorkspaceLayout, saveWorkspaceLayout } from './windowPersistence'
import {
  clampWorkspaceGeometry,
  createWorkspaceWindow,
  maximizedWorkspaceGeometry,
  type OpenWorkspaceWindowInput,
  type WorkspaceWindowGeometry,
  type WorkspaceWindowState,
  type WorkspaceStageSize,
} from './windowModel'

/** 历史抽屉栈最大深度（防多级 spawn 递归下钻失控）。 */
const HISTORY_STACK_MAX = 5

/** 全屏 overlay 类型（"共用单蒙层"用，按 z 优先级排序）。 */
export type OverlayKind = 'settings' | 'agentDialog' | 'historyDrawer' | 'sessionList'

export type HistoryDrawerMode = 'overlay' | 'workbench-docked'
export interface HistoryDrawerAnchor {
  top: number
  left: number
  width: number
  height: number
}

/** 历史抽屉子 agent 消息显示模式：
 *  - 'show'    不折叠：全部显示
 *  - 'collapse' 折叠：隐藏子 agent（role/subagent）消息
 *  - 'round'    只保留用户与大模型单个轮次最后一条消息 */
export type SubagentDisplayMode = 'show' | 'collapse' | 'round'

/** 节点树工作台多窗口状态（每预设一窗，key = presetId）。独立于下方单例投影。 */
export interface WorkbenchWindowState {
  id: string // = presetId（每预设一窗）
  presetId: string
  /** 入口携带的预设名（空白工作台/会话未水合时角色编制据此解析，不靠会话推导）。 */
  presetName: string | null
  chatId: string | null // 当前根会话
  view: 'composer' | 'attention' | 'tree'
  minimized: boolean
  mode: 'fullscreen' | 'window'
  position: { x: number; y: number }
  size: { width: number; height: number }
  historyDrawerStack: string[]
  historyDrawerMode: 'overlay' | 'workbench-docked'
  historyDrawerAnchor: HistoryDrawerAnchor | null
  workspaceBrowserMode?: 'attention'
  focused: boolean
  zOrder: number
  attentionBlink: boolean
  interactionFocus?: { sourceChatId?: string; interactionId?: string; anchorNodeId?: string }
}

/** UI 焦点 / 面板开关 / 滚动触发——独立于数据层的纯 UI 状态。 */
export function createUiState() {
  const activeDialogChatId = ref<string | null>(null)
  /** preset workspace key -> currently selected root chat. Pet identity stays stable. */
  const activeRootByPreset = ref<Record<string, string>>({})
  /** pet=quick composer requires an explicit target; history=context is already fixed; nyxus=直接发消息浮动窗（无遮罩，目标固定）。 */
  const activeDialogSource = ref<'pet' | 'history' | 'nyxus'>('history')
  const activeDialogView = ref<'composer' | 'attention' | 'tree'>('composer')
  /** 最小化仅隐藏工作台 DOM；会话、草稿、树订阅与运行状态保持。 */
  const workbenchMinimized = ref(false)
  // 当前「活跃」的 Cherry Nyxus 会话 id（页面与桌面入口绑定此会话）。null 时 selector 回退到最近一条。
  const activeNyxusChatId = ref<string | null>(null)
  // 历史抽屉栈：chatId 数组，栈底=根抽屉，栈顶=当前可见层。空=无抽屉。
  // spawn 多级下钻逐层 push（盖在上层之上）；ESC/遮罩/✕ 仅 pop 栈顶（逐层返回）。
  const historyDrawerStack = ref<string[]>([])
  const historyDrawerMode = ref<HistoryDrawerMode>('overlay')
  const historyDrawerAnchor = ref<HistoryDrawerAnchor | null>(null)
  const historyDrawerTaskBranches = ref<import('@/services/agentApi').ConversationBranchSummary[]>(
    [],
  )
  /** 历史抽屉二层代际视图（栈深恒 ≤2 的第二层）：root 面板展开的已打包代。null = 关闭。 */
  const historyDrawerGeneration = ref<{ rootChatId: string; generationIndex: number } | null>(null)
  const historyListOpen = ref(false)
  const settingsOpen = ref(false)
  /** Feedback actions can open Settings directly at the relevant configuration area. */
  const settingsSection = ref<SettingsSection | null>(null)
  const pendingScrollSenseCallId = ref<string | null>(null)
  // 子 agent 消息显示模式（跨所有 chat 持久；VirtualScroll 离屏销毁 MessageBubble 会丢 local 态，故放 store 兜底）。
  const subagentDisplay = ref<SubagentDisplayMode>('show')
  // 工具调用折叠开关：开启后 MessageBubble 的 senseCalls 折叠为一行小 tag，hover tag 悬浮显完整渲染器内容。
  // 与 subagentDisplay 同款内存态（离屏销毁丢 local 态，故放 store）。
  const senseCallsCollapsed = ref(false)

  // Generic UI-only cyber desktop windows. Canonical chat/run/interaction data
  // remains in its existing owners and is referenced here only by stable ids.
  const workspaceWindows = ref<Record<string, WorkspaceWindowState>>({})
  const workspaceWindowOrder = ref<string[]>([])
  const focusedWorkspaceWindowId = ref<string | null>(null)
  const workspaceStageSize = ref<WorkspaceStageSize>({ width: 1920, height: 1010 })
  /** 窗口创建序计数器（sequence 单调递增；restore 后取已有最大值 +1 续号）。 */
  let workspaceWindowSequence = 0

  function persistWorkspaceWindows(): void {
    saveWorkspaceLayout(workspaceWindows.value, workspaceWindowOrder.value)
  }

  function focusWorkspaceWindow(id: string): void {
    const target = workspaceWindows.value[id]
    if (!target) return
    const order = workspaceWindowOrder.value
    const current = order.indexOf(id)
    if (current >= 0) order.splice(current, 1)
    order.push(id)
    order.forEach((windowId, index) => {
      const window = workspaceWindows.value[windowId]
      if (!window) return
      window.focused = windowId === id
      window.zOrder = index
    })
    target.attention = false
    focusedWorkspaceWindowId.value = id
    persistWorkspaceWindows()
  }

  function openOrFocusWindow(input: OpenWorkspaceWindowInput): string {
    const id = `window:${input.resourceKey}`
    const existing = workspaceWindows.value[id]
    if (existing) {
      existing.lifecycle = 'open'
      existing.title = input.title
      existing.context = input.context
      existing.kind = input.context.kind
      focusWorkspaceWindow(id)
      return id
    }
    for (const window of Object.values(workspaceWindows.value)) window.focused = false
    const window = createWorkspaceWindow(
      input,
      workspaceWindowOrder.value.length,
      workspaceStageSize.value,
      workspaceWindowSequence++,
    )
    workspaceWindows.value[window.id] = window
    workspaceWindowOrder.value.push(window.id)
    focusedWorkspaceWindowId.value = window.id
    persistWorkspaceWindows()
    return window.id
  }

  function markWorkspaceWindowOpen(id: string): void {
    const window = workspaceWindows.value[id]
    if (window?.lifecycle === 'opening') window.lifecycle = 'open'
  }

  function minimizeWorkspaceWindow(id: string): void {
    const window = workspaceWindows.value[id]
    if (!window) return
    window.lifecycle = 'minimized'
    window.focused = false
    const next = workspaceWindowOrder.value
      .map((windowId) => workspaceWindows.value[windowId])
      .findLast((candidate) => candidate && candidate.lifecycle !== 'minimized' && candidate.id !== id)
    focusedWorkspaceWindowId.value = next?.id ?? null
    if (next) focusWorkspaceWindow(next.id)
    else persistWorkspaceWindows()
  }

  function restoreWorkspaceWindow(id: string): void {
    const window = workspaceWindows.value[id]
    if (!window) return
    window.lifecycle = 'open'
    focusWorkspaceWindow(id)
  }

  function beginWorkspaceWindowClose(id: string): void {
    const window = workspaceWindows.value[id]
    if (window) window.lifecycle = 'closing'
  }

  function removeWorkspaceWindow(id: string): void {
    if (!workspaceWindows.value[id]) return
    delete workspaceWindows.value[id]
    workspaceWindowOrder.value = workspaceWindowOrder.value.filter((windowId) => windowId !== id)
    const nextId = workspaceWindowOrder.value.at(-1) ?? null
    focusedWorkspaceWindowId.value = nextId
    if (nextId) focusWorkspaceWindow(nextId)
    else persistWorkspaceWindows()
  }

  function setWorkspaceWindowGeometry(id: string, geometry: WorkspaceWindowGeometry): void {
    const window = workspaceWindows.value[id]
    if (!window || window.maximized) return
    window.geometry = clampWorkspaceGeometry(geometry, workspaceStageSize.value)
    persistWorkspaceWindows()
  }

  function setWorkspaceStageSize(stage: WorkspaceStageSize): void {
    if (stage.width <= 0 || stage.height <= 0) return
    workspaceStageSize.value = stage
    for (const window of Object.values(workspaceWindows.value)) {
      window.geometry = window.maximized
        ? maximizedWorkspaceGeometry(stage)
        : clampWorkspaceGeometry(window.geometry, stage)
      if (window.restoreGeometry) {
        window.restoreGeometry = clampWorkspaceGeometry(window.restoreGeometry, stage)
      }
    }
  }

  function maximizeWorkspaceWindow(id: string): void {
    const window = workspaceWindows.value[id]
    if (!window || window.maximized) return
    window.restoreGeometry = { ...window.geometry }
    window.geometry = maximizedWorkspaceGeometry(workspaceStageSize.value)
    window.maximized = true
    focusWorkspaceWindow(id)
  }

  function unmaximizeWorkspaceWindow(id: string): void {
    const window = workspaceWindows.value[id]
    if (!window || !window.maximized) return
    window.maximized = false
    window.geometry = clampWorkspaceGeometry(
      window.restoreGeometry ?? window.geometry,
      workspaceStageSize.value,
    )
    delete window.restoreGeometry
    focusWorkspaceWindow(id)
  }

  function toggleWorkspaceWindowMaximized(id: string): void {
    const window = workspaceWindows.value[id]
    if (!window) return
    if (window.maximized) unmaximizeWorkspaceWindow(id)
    else maximizeWorkspaceWindow(id)
  }

  function restoreWorkspaceLayout(
    valid: (window: WorkspaceWindowState) => boolean = () => true,
  ): void {
    const snapshot = loadWorkspaceLayout()
    if (!snapshot) return
    // 旧持久化无 sequence 字段：按快照数组下标兜底，保证任务栏展示序稳定。
    const restored = snapshot.windows.filter(valid).map((window, index) => ({
      ...window,
      sequence: Number.isFinite(window.sequence) ? window.sequence : index,
    }))
    const transient = Object.values(workspaceWindows.value).filter((window) => !window.persistent)
    workspaceWindows.value = Object.fromEntries(
      [...restored, ...transient].map((window) => [window.id, window]),
    )
    workspaceWindowSequence = [...restored, ...transient].reduce(
      (max, window) => Math.max(max, window.sequence + 1),
      0,
    )
    workspaceWindowOrder.value = [
      ...snapshot.order.filter((id) => !!workspaceWindows.value[id]),
      ...transient.map((window) => window.id),
    ]
    focusedWorkspaceWindowId.value = null
  }

  const workspaceWindowsList = computed(() =>
    workspaceWindowOrder.value
      .map((id) => workspaceWindows.value[id])
      .filter((window): window is WorkspaceWindowState => !!window),
  )

  /** 任务栏展示序：按创建序（sequence）稳定排序，与 z 序（workspaceWindowsList）分离——
   *  聚焦/切换窗口不改变任务栏排列，当前窗口仅以高亮标记。 */
  const workspaceWindowsTaskbarList = computed(() =>
    Object.values(workspaceWindows.value)
      .filter((window): window is WorkspaceWindowState => !!window)
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
  )

  /** 栈顶 chatId（无抽屉时 null）。供仅需“当前焦点”的旧调用方读。 */
  const topHistoryChatId: ComputedRef<string | null> = computed(() => {
    const stack = historyDrawerStack.value
    return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null
  })

  /** 当前栈顶 overlay 类型（按 z 优先级）。用于“共用单蒙层”：同屏仅栈顶 overlay 蒙层盖纯 scrim
   *  （无 backdrop-filter blur——pet rAF 持续动画下 blur 每帧重采样整屏重绘，见 docs/web/renderer.md
   *  遮罩实现约束），非栈顶蒙层透明，避免多层遮罩叠加导致底层完全不可见。
   *  优先级：settings > historyDrawer > agentDialog > sessionList。
   *  历史由 Nyxus 输入弹窗主动打开时，抽屉是当前浏览焦点，应处于该弹窗之上。 */
  const topOverlay: ComputedRef<OverlayKind | null> = computed(() => {
    if (settingsOpen.value) return 'settings'
    const dockedDrawerHidden =
      workbenchMinimized.value && historyDrawerMode.value === 'workbench-docked'
    if (historyDrawerStack.value.length > 0 && !dockedDrawerHidden) return 'historyDrawer'
    if (activeDialogChatId.value && !workbenchMinimized.value) return 'agentDialog'
    if (historyListOpen.value) return 'sessionList'
    return null
  })

  /** 打开根抽屉（PetStage 从 pet 列表打开）：重置栈为单元素（新浏览会话，不叠加旧栈）。 */
  function openHistoryRoot(
    chatId: string,
    mode: HistoryDrawerMode = 'overlay',
    anchor: HistoryDrawerAnchor | null = null,
  ): void {
    historyDrawerMode.value = mode
    historyDrawerAnchor.value = mode === 'workbench-docked' ? anchor : null
    historyDrawerStack.value = [chatId]
    historyDrawerGeneration.value = null
  }

  /** 打开抽屉二层代际视图（抽屉卡片 / 树 pack 节点联动共用入口）。 */
  function openHistoryGeneration(rootChatId: string, generationIndex: number): void {
    historyDrawerGeneration.value = { rootChatId, generationIndex }
  }

  /** 关闭抽屉二层代际视图（仅二层；首层抽屉栈不受影响）。 */
  function closeHistoryGeneration(): void {
    historyDrawerGeneration.value = null
  }

  function updateHistoryDrawerAnchor(anchor: HistoryDrawerAnchor | null): void {
    if (historyDrawerMode.value !== 'workbench-docked') return
    historyDrawerAnchor.value = anchor
  }

  /** 下钻子 chat（SpawnRenderer「详情」）：push 栈顶。无抽屉 / 栈顶已是该 id / 超上限则忽略。 */
  function drillHistoryChild(chatId: string): void {
    const stack = historyDrawerStack.value
    if (stack.length === 0) return // 无抽屉（下钻必在抽屉内触发，理论不达）
    if (stack[stack.length - 1] === chatId) return // 防重复
    if (stack.length >= HISTORY_STACK_MAX) {
      console.warn(
        `[uiState] drillHistoryChild: 栈已达上限 ${HISTORY_STACK_MAX}，忽略下钻 ${chatId}`,
      )
      return
    }
    stack.push(chatId)
  }

  /** 关闭栈顶（✕ / 遮罩 / ESC）：逐层返回。 */
  function closeHistoryTop(): void {
    historyDrawerStack.value.pop()
    historyDrawerGeneration.value = null
    if (historyDrawerStack.value.length === 0) {
      historyDrawerMode.value = 'overlay'
      historyDrawerAnchor.value = null
    }
  }

  /** 关闭全部抽屉。 */
  function closeAllHistory(): void {
    historyDrawerStack.value = []
    historyDrawerMode.value = 'overlay'
    historyDrawerAnchor.value = null
    historyDrawerTaskBranches.value = []
    historyDrawerGeneration.value = null
  }

  /** 设置子 agent 消息显示模式。 */
  function setSubagentDisplay(mode: SubagentDisplayMode): void {
    subagentDisplay.value = mode
  }

  /** 切换工具调用折叠开关（true = senseCalls 折叠为小 tag）。 */
  function setSenseCallsCollapsed(collapsed: boolean): void {
    senseCallsCollapsed.value = collapsed
  }

  // ---- 节点树工作台多窗口注册表（每预设一窗，key = presetId） ----
  const workbenchWindows = ref<Record<string, WorkbenchWindowState>>({})
  // z 序：index 小 = 底层，末尾 = 最上层。
  const workbenchWindowOrder = ref<string[]>([])
  const focusedWorkbenchWindowId = ref<string | null>(null)

  /** id 存在性守卫：不存在则 console.warn 并 return false（调用方据此失败返回）。 */
  function guardWorkbenchWindow(id: string): boolean {
    if (!workbenchWindows.value[id]) {
      console.warn(`[uiState] workbench window ${id} 不存在，忽略写入`)
      return false
    }
    return true
  }

  /** 打开窗口：已存在同 presetId 则置焦点并返回其 id；否则新建并注册。
   *  presetName 为入口携带的预设名（非 presetId）；已存在窗口时防御性补写（入口解析失败
   *  留下的旧窗 presetName 恒 null 也可被后续打开纠正）。 */
  function openWorkbenchWindow(presetId: string, presetName?: string): string {
    const genericId = openOrFocusWindow({
      resourceKey: `graph:${presetId}`,
      title: presetName?.trim() || '节点树工作台',
      context: { kind: 'graph', presetId },
      geometry: { width: 1280, height: 780 },
    })
    const existing = workbenchWindows.value[presetId]
    if (existing) {
      if (presetName && existing.presetName !== presetName) existing.presetName = presetName
      markWorkspaceWindowOpen(genericId)
      focusWorkbenchWindow(existing.id)
      return existing.id
    }
    const id = presetId
    const order = workbenchWindowOrder.value
    const window: WorkbenchWindowState = {
      id,
      presetId,
      presetName: presetName ?? null,
      chatId: null,
      view: 'tree',
      minimized: false,
      mode: 'fullscreen',
      position: { x: 0, y: 0 },
      size: { width: 0, height: 0 },
      historyDrawerStack: [],
      historyDrawerMode: 'overlay',
      historyDrawerAnchor: null,
      focused: true,
      zOrder: order.length,
      attentionBlink: false,
    }
    workbenchWindows.value[id] = window
    order.push(id)
    focusedWorkbenchWindowId.value = id
    markWorkspaceWindowOpen(genericId)
    return id
  }

  /** 关闭窗口：从 map 与 order 移除；若移除的是焦点窗，焦点移到 order 末尾。 */
  function closeWorkbenchWindow(id: string): void {
    if (!guardWorkbenchWindow(id)) return
    delete workbenchWindows.value[id]
    const order = workbenchWindowOrder.value
    const idx = order.indexOf(id)
    if (idx !== -1) order.splice(idx, 1)
    if (focusedWorkbenchWindowId.value === id) {
      const last = order[order.length - 1]
      focusedWorkbenchWindowId.value = last ?? null
    }
    removeWorkspaceWindow(`window:graph:${id}`)
  }

  /** 置焦点：该 id 移到 order 末尾，其它窗口 focused=false。 */
  function focusWorkbenchWindow(id: string): void {
    if (!guardWorkbenchWindow(id)) return
    const order = workbenchWindowOrder.value
    const idx = order.indexOf(id)
    if (idx !== -1) {
      order.splice(idx, 1)
      order.push(id)
    }
    for (const w of Object.values(workbenchWindows.value)) {
      w.focused = w.id === id
    }
    focusedWorkbenchWindowId.value = id
    focusWorkspaceWindow(`window:graph:${id}`)
  }

  /** 守卫后写单个窗口字段的通用 setter。 */
  function setWorkbenchWindowField<K extends keyof WorkbenchWindowState>(
    id: string,
    field: K,
    value: WorkbenchWindowState[K],
  ): void {
    if (!guardWorkbenchWindow(id)) return
    workbenchWindows.value[id]![field] = value
  }

  function setWorkbenchWindowMinimized(id: string, minimized: boolean): void {
    setWorkbenchWindowField(id, 'minimized', minimized)
    if (minimized) minimizeWorkspaceWindow(`window:graph:${id}`)
    else restoreWorkspaceWindow(`window:graph:${id}`)
  }

  function setWorkbenchWindowChat(id: string, chatId: string | null): void {
    setWorkbenchWindowField(id, 'chatId', chatId)
  }

  function setWorkbenchWindowView(id: string, view: 'composer' | 'attention' | 'tree'): void {
    setWorkbenchWindowField(id, 'view', view)
  }

  function setWorkbenchWindowGeometry(
    id: string,
    geometry: {
      mode: 'fullscreen' | 'window'
      position: { x: number; y: number }
      size: { width: number; height: number }
    },
  ): void {
    if (!guardWorkbenchWindow(id)) return
    const win = workbenchWindows.value[id]!
    win.mode = geometry.mode
    win.position = geometry.position
    win.size = geometry.size
    if (geometry.mode === 'window' && geometry.size.width > 0 && geometry.size.height > 0) {
      setWorkspaceWindowGeometry(`window:graph:${id}`, {
        x: geometry.position.x,
        y: geometry.position.y,
        width: geometry.size.width,
        height: geometry.size.height,
      })
    }
  }

  function setWorkbenchWindowBlink(id: string, blink: boolean): void {
    setWorkbenchWindowField(id, 'attentionBlink', blink)
  }

  function setWorkbenchWindowFocus(
    id: string,
    focus: WorkbenchWindowState['interactionFocus'],
  ): void {
    setWorkbenchWindowField(id, 'interactionFocus', focus)
  }

  function setWorkbenchWindowDrawer(
    id: string,
    drawer: {
      stack: string[]
      mode: 'overlay' | 'workbench-docked'
      anchor: HistoryDrawerAnchor | null
    },
  ): void {
    if (!guardWorkbenchWindow(id)) return
    const win = workbenchWindows.value[id]!
    win.historyDrawerStack = drawer.stack
    win.historyDrawerMode = drawer.mode
    win.historyDrawerAnchor = drawer.anchor
  }

  function setWorkbenchWindowWorkspaceBrowser(id: string, mode: 'attention' | undefined): void {
    if (!guardWorkbenchWindow(id)) return
    const win = workbenchWindows.value[id]!
    if (mode === undefined) {
      delete win.workspaceBrowserMode
    } else {
      win.workspaceBrowserMode = mode
    }
  }

  /** 按 z 序（order 顺序）返回窗口数组。 */
  const workbenchWindowsList: ComputedRef<WorkbenchWindowState[]> = computed(() =>
    workbenchWindowOrder.value
      .map((id) => workbenchWindows.value[id])
      .filter((w): w is WorkbenchWindowState => w != null),
  )

  /** 清理被删除的 chat（removePetsByIds）：从栈中移除所有命中项。 */
  function pruneHistoryStack(removeIds: string[]): void {
    if (removeIds.length === 0) return
    const set = new Set(removeIds)
    historyDrawerStack.value = historyDrawerStack.value.filter((id) => !set.has(id))
    if (set.has(historyDrawerGeneration.value?.rootChatId ?? '')) {
      historyDrawerGeneration.value = null
    }
    if (historyDrawerStack.value.length === 0) {
      historyDrawerMode.value = 'overlay'
      historyDrawerAnchor.value = null
    }
  }

  /** Remove every UI reference to permanently deleted chats while preserving
   * cross-session preferences such as window geometry, layout and theme. */
  function pruneDeletedChats(removeIds: readonly string[]): void {
    if (removeIds.length === 0) return
    const removed = new Set(removeIds)
    pruneHistoryStack([...removed])

    if (activeDialogChatId.value && removed.has(activeDialogChatId.value)) {
      activeDialogChatId.value = null
    }
    if (activeNyxusChatId.value && removed.has(activeNyxusChatId.value)) {
      activeNyxusChatId.value = null
    }
    for (const [preset, chatId] of Object.entries(activeRootByPreset.value)) {
      if (removed.has(chatId)) delete activeRootByPreset.value[preset]
    }
    historyDrawerTaskBranches.value = historyDrawerTaskBranches.value.filter(
      (branch) => !removed.has(branch.chatId),
    )

    for (const window of Object.values(workbenchWindows.value)) {
      if (window.chatId && removed.has(window.chatId)) window.chatId = null
      window.historyDrawerStack = window.historyDrawerStack.filter((id) => !removed.has(id))
      if (
        window.interactionFocus?.sourceChatId &&
        removed.has(window.interactionFocus.sourceChatId)
      ) {
        delete window.interactionFocus
      }
      if (window.historyDrawerStack.length === 0) {
        window.historyDrawerMode = 'overlay'
        window.historyDrawerAnchor = null
      }
    }
    for (const window of Object.values(workspaceWindows.value)) {
      const context = window.context
      const chatId =
        context.kind === 'session'
          ? context.chatId
          : context.kind === 'history'
            ? context.rootChatId
            : context.kind === 'graph' || context.kind === 'diagnostic'
              ? context.chatId
              : undefined
      if (chatId && removed.has(chatId)) removeWorkspaceWindow(window.id)
    }
  }

  return {
    activeDialogChatId,
    activeRootByPreset,
    activeDialogSource,
    activeDialogView,
    workbenchMinimized,
    activeNyxusChatId,
    historyDrawerStack,
    historyDrawerMode,
    historyDrawerAnchor,
    historyDrawerTaskBranches,
    historyDrawerGeneration,
    topHistoryChatId,
    topOverlay,
    openHistoryRoot,
    openHistoryGeneration,
    closeHistoryGeneration,
    updateHistoryDrawerAnchor,
    drillHistoryChild,
    closeHistoryTop,
    closeAllHistory,
    pruneHistoryStack,
    pruneDeletedChats,
    historyListOpen,
    settingsOpen,
    settingsSection,
    pendingScrollSenseCallId,
    subagentDisplay,
    setSubagentDisplay,
    senseCallsCollapsed,
    setSenseCallsCollapsed,
    workspaceWindows,
    workspaceStageSize,
    workspaceWindowOrder,
    focusedWorkspaceWindowId,
    workspaceWindowsList,
    workspaceWindowsTaskbarList,
    openOrFocusWindow,
    focusWorkspaceWindow,
    markWorkspaceWindowOpen,
    minimizeWorkspaceWindow,
    restoreWorkspaceWindow,
    beginWorkspaceWindowClose,
    removeWorkspaceWindow,
    setWorkspaceWindowGeometry,
    setWorkspaceStageSize,
    maximizeWorkspaceWindow,
    unmaximizeWorkspaceWindow,
    toggleWorkspaceWindowMaximized,
    restoreWorkspaceLayout,
    workbenchWindows,
    workbenchWindowOrder,
    focusedWorkbenchWindowId,
    workbenchWindowsList,
    openWorkbenchWindow,
    closeWorkbenchWindow,
    focusWorkbenchWindow,
    setWorkbenchWindowMinimized,
    setWorkbenchWindowChat,
    setWorkbenchWindowView,
    setWorkbenchWindowGeometry,
    setWorkbenchWindowBlink,
    setWorkbenchWindowFocus,
    setWorkbenchWindowDrawer,
    setWorkbenchWindowWorkspaceBrowser,
  }
}
