import { computed, ref, type ComputedRef } from 'vue'

/** 历史抽屉栈最大深度（防多级 spawn 递归下钻失控）。 */
const HISTORY_STACK_MAX = 5

/** 全屏 overlay 类型（"共用单蒙层"用，按 z 优先级排序）。 */
export type OverlayKind = 'settings' | 'agentDialog' | 'historyDrawer' | 'sessionList'

/** UI 焦点 / 面板开关 / 滚动触发——独立于数据层的纯 UI 状态。 */
export function createUiState() {
  const activeDialogChatId = ref<string | null>(null)
  // 历史抽屉栈：chatId 数组，栈底=根抽屉，栈顶=当前可见层。空=无抽屉。
  // spawn 多级下钻逐层 push（盖在上层之上）；ESC/遮罩/✕ 仅 pop 栈顶（逐层返回）。
  const historyDrawerStack = ref<string[]>([])
  const historyListOpen = ref(false)
  const settingsOpen = ref(false)
  const pendingScrollSenseCallId = ref<string | null>(null)
  // 全局折叠子 agent 消息（role='role'/'subagent'）开关：跨所有 chat 持久。
  // VirtualScroll 离屏销毁 MessageBubble 会丢 local 折叠态，故放 store 兜底。
  const collapseSubagent = ref(false)

  /** 栈顶 chatId（无抽屉时 null）。供仅需“当前焦点”的旧调用方读。 */
  const topHistoryChatId: ComputedRef<string | null> = computed(() => {
    const stack = historyDrawerStack.value
    return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null
  })

  /** 当前栈顶 overlay 类型（按 z 优先级）。用于“共用单蒙层”：同屏仅栈顶 overlay 蒙层带 blur，
   *  非栈顶蒙层透明，避免多层 blur 叠加导致底层完全不可见。
   *  优先级：settings > agentDialog > historyDrawer > sessionList。 */
  const topOverlay: ComputedRef<OverlayKind | null> = computed(() => {
    if (settingsOpen.value) return 'settings'
    if (activeDialogChatId.value) return 'agentDialog'
    if (historyDrawerStack.value.length > 0) return 'historyDrawer'
    if (historyListOpen.value) return 'sessionList'
    return null
  })

  /** 打开根抽屉（PetStage 从 pet 列表打开）：重置栈为单元素（新浏览会话，不叠加旧栈）。 */
  function openHistoryRoot(chatId: string): void {
    historyDrawerStack.value = [chatId]
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
  }

  /** 关闭全部抽屉。 */
  function closeAllHistory(): void {
    historyDrawerStack.value = []
  }

  /** 切换全局子 agent 消息折叠状态。 */
  function toggleCollapseSubagent(): void {
    collapseSubagent.value = !collapseSubagent.value
  }

  /** 清理被删除的 chat（removePetsByIds）：从栈中移除所有命中项。 */
  function pruneHistoryStack(removeIds: string[]): void {
    if (removeIds.length === 0) return
    const set = new Set(removeIds)
    historyDrawerStack.value = historyDrawerStack.value.filter((id) => !set.has(id))
  }

  return {
    activeDialogChatId,
    historyDrawerStack,
    topHistoryChatId,
    topOverlay,
    openHistoryRoot,
    drillHistoryChild,
    closeHistoryTop,
    closeAllHistory,
    pruneHistoryStack,
    historyListOpen,
    settingsOpen,
    pendingScrollSenseCallId,
    collapseSubagent,
    toggleCollapseSubagent,
  }
}
