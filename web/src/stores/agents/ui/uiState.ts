import { computed, ref, type ComputedRef } from 'vue'

/** 历史抽屉栈最大深度（防多级 spawn 递归下钻失控）。 */
const HISTORY_STACK_MAX = 5

/** 全屏 overlay 类型（"共用单蒙层"用，按 z 优先级排序）。 */
export type OverlayKind =
  | 'settings'
  | 'agentDialog'
  | 'historyDrawer'
  | 'sessionList'

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

/** UI 焦点 / 面板开关 / 滚动触发——独立于数据层的纯 UI 状态。 */
export function createUiState() {
  const activeDialogChatId = ref<string | null>(null)
  /** preset workspace key -> currently selected root chat. Pet identity stays stable. */
  const activeRootByPreset = ref<Record<string, string>>({})
  /** pet=quick composer requires an explicit target; history=context is already fixed. */
  const activeDialogSource = ref<'pet' | 'history'>('history')
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
  const historyListOpen = ref(false)
  const settingsOpen = ref(false)
  const pendingScrollSenseCallId = ref<string | null>(null)
  // 子 agent 消息显示模式（跨所有 chat 持久；VirtualScroll 离屏销毁 MessageBubble 会丢 local 态，故放 store 兜底）。
  const subagentDisplay = ref<SubagentDisplayMode>('show')

  /** 栈顶 chatId（无抽屉时 null）。供仅需“当前焦点”的旧调用方读。 */
  const topHistoryChatId: ComputedRef<string | null> = computed(() => {
    const stack = historyDrawerStack.value
    return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null
  })

  /** 当前栈顶 overlay 类型（按 z 优先级）。用于“共用单蒙层”：同屏仅栈顶 overlay 蒙层带 blur，
   *  非栈顶蒙层透明，避免多层 blur 叠加导致底层完全不可见。
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
  }

  /** 设置子 agent 消息显示模式。 */
  function setSubagentDisplay(mode: SubagentDisplayMode): void {
    subagentDisplay.value = mode
  }

  /** 清理被删除的 chat（removePetsByIds）：从栈中移除所有命中项。 */
  function pruneHistoryStack(removeIds: string[]): void {
    if (removeIds.length === 0) return
    const set = new Set(removeIds)
    historyDrawerStack.value = historyDrawerStack.value.filter((id) => !set.has(id))
    if (historyDrawerStack.value.length === 0) {
      historyDrawerMode.value = 'overlay'
      historyDrawerAnchor.value = null
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
    topHistoryChatId,
    topOverlay,
    openHistoryRoot,
    updateHistoryDrawerAnchor,
    drillHistoryChild,
    closeHistoryTop,
    closeAllHistory,
    pruneHistoryStack,
    historyListOpen,
    settingsOpen,
    pendingScrollSenseCallId,
    subagentDisplay,
    setSubagentDisplay,
  }
}
