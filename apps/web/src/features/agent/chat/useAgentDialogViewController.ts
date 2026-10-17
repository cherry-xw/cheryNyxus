/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * C-3 抽取后仅保留「快速发送 composer 弹窗」单例面板（Pet 单击打开）。
 * 节点树工作台已抽到 WorkbenchDialog（多窗口），此处不再承载 .workbench-shell 子树。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体预览下沉 MediaThumbStrip。
 */
import { computed, onBeforeUnmount, onMounted, onUnmounted, reactive, ref, watch, type CSSProperties } from 'vue'
import { ElPopover, ElTooltip } from 'element-plus'
import { useOverlayTransitionHooks } from '@/composables/useOverlayAnimation'
import { RoleConfigPopover } from '../runtime/public'
import {
  AgentComposer,
  ConversationTargetPicker,
  RoutingTraceWindow,
  useAgentDialogOptions,
  useComposerMenuPosition,
  type RouteStatus,
} from '../composer/public'
import { WorkspaceSessionBrowser } from '../attention/public'
import ContextBreakdownTip from '../toolbar/ContextBreakdownTip.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import { ownerOverlayZIndex } from '@/styles/overlayLayers'
import { useAgentsStore, useInteractionsStore } from '@/application/public'

export function useAgentDialogViewController(props: Readonly<{ embedded?: boolean }>) {
  const shellless = computed(() => props.embedded)

  const agents = useAgentsStore()

  const interactions = useInteractionsStore()

  // 共用单蒙层：仅当 AgentDialog 是栈顶 overlay 且非 pet/nyxus 来源时其蒙层带 blur，否则透明。
  // pet 发送窗口与 nyxus 直接发消息浮动窗要求无遮罩（可拖动、不叠层），故 activeDialogSource 为
  // 'pet' 或 'nyxus' 时始终透明；'history' 为历史抽屉式模态，带遮罩。
  const isTopMask = computed(
    () =>
      agents.topOverlay === 'agentDialog' &&
      agents.activeDialogSource !== 'pet' &&
      agents.activeDialogSource !== 'nyxus',
  )

  const overlayMotion = useOverlayTransitionHooks('dialog')

  // pet/nyxus 来源为无遮罩浮动窗，overlay 的
  // 全屏 DOM 不能拦截命中测试——置 pointer-events:none 让穿透判定只认 panel 实体，
  // panel 内部恢复 auto（agentDialog.less 的 .dialog-panel）。
  const isFloatingOverlay = computed(
    () => agents.activeDialogSource === 'pet' || agents.activeDialogSource === 'nyxus',
  )

  const {
    chatId,
    pet,
    presetName,
    brains,
    senseGroups,
    config,
    senseTools,
    roleSelections,
    primaryRole,
    text,
    editorRef,
    commandOptions,
    commandTabs,
    activeCommandTab,
    comboCommandGroups,
    showCommandMenu,
    activeCommandIndex,
    commandMenuRef,
    roleMenuRef,
    matchingRoleMentions,
    matchingFiles,
    showFileMenu,
    activeFileIndex,
    fileMenuHint,
    showRoleMenu,
    activeRoleIndex,
    uploading,
    mediaHint,
    runtimeHint,
    runtimeError,
    mediaAttachments,
    sending,
    loading,
    error,
    primarySelection,
    orderedRoleSelections,
    mediaServicesByType,
    close: closeAgentDialog,
    handleSend,
    onEditorKeydown,
    onEditorInput,
    onEditorSelectionChange,
    onEditorPaste,
    selectCommand,
    selectCommandTab,
    selectRoleMention,
    selectFileMention,
    removeMedia,
    toggleMediaVariant,
    onMediaSelected,
    senseEntries,
    senseTool,
    brainConfig,
    supportsTools,
  } = useAgentDialogOptions()


  /** 快速发送 composer 单例面板：仅有活跃 chatId 时可见（Pet 单击/PetStage 打开）。 */
  interface QuickTargetSelection {
    target: string | 'new'
    source: 'ai' | 'user'
    confidence?: number
  }

  interface ConversationTargetPickerExpose {
    routeForSend: (draft: string) => Promise<QuickTargetSelection | undefined>
  }

  const targetPickerRef = ref<ConversationTargetPickerExpose>()

  const quickTarget = ref<QuickTargetSelection>()

  const quickRoutingPending = ref(false)

  const quickAutoMode = ref(false)

  function setQuickRoutingPending(pending: boolean): void {
    quickRoutingPending.value = pending
  }

  function clearAiQuickTarget(): void {
    if (quickTarget.value?.source === 'ai') quickTarget.value = undefined
  }

  function enableAiQuickTarget(): void {
    quickTarget.value = undefined
    error.value = null
  }

  // 切会话清残留目标：钢琴键/历史列表/retarget 等外部切换不经过 picker，旧会话的选择
  // （尤其 'new'）对新会话无意义；composer 原生窗 keepAlive 不销毁组件，残留 'new' 会在
  // 下次发送时静默 chat.create 新会话。生命周期约定见 docs/shared/protocol/interactions.md chat.route.suggest。
  watch(chatId, () => {
    quickTarget.value = undefined
  })

  const dialogView = computed({
    get: () => agents.activeDialogView,
    set: (view: 'composer' | 'attention' | 'tree') => {
      agents.activeDialogView = view
    },
  })

  const quickTargetRequired = computed(
    () =>
      (agents.activeDialogSource === 'pet' || agents.activeDialogSource === 'nyxus') &&
      !!presetName.value,
  )

  const quickPresetId = computed(() => {
    if (pet.value?.presetId) return pet.value.presetId
    const summary = chatId.value
      ? agents.historyList.find((item) => item.chatId === chatId.value)
      : undefined
    return summary?.presetId
  })

  /** 与 quickPresetId 同源配对的预设名（pet.preset / 同条 summary.preset），工作台入口随窗携带。 */
  const quickPresetName = computed(() => {
    if (pet.value?.preset) return pet.value.preset
    const summary = chatId.value
      ? agents.historyList.find((item) => item.chatId === chatId.value)
      : undefined
    return summary?.preset
  })

  /**
   * Pet quick chat and its preset workbench are mutually exclusive. Keep the
   * dialog state and draft alive so closing the workbench restores the bubble.
   */
  const petWorkbenchOpen = computed(() => {
    if (agents.activeDialogSource !== 'pet') return false
    const presetId = quickPresetId.value
    return !!presetId && !!agents.workbenchWindows[presetId]
  })

  const dialogVisible = computed(() => !!chatId.value && !petWorkbenchOpen.value)

  // 小组角色编制默认折叠：仅占一行（标题行），剩余高度全部分配给输入框；点击标题行展开角色标签。
  const rolesExpanded = ref(false)

  const quickSessions = computed(() =>
    (agents.historyList ?? [])
      .filter(
        (item) =>
          !item.parentChatId &&
          (quickPresetId.value
            ? item.presetId === quickPresetId.value
            : !!presetName.value && item.preset === presetName.value),
      )
      .sort(
        (a, b) =>
          (b.lastUserActivityAt ?? b.createdAt ?? 0) - (a.lastUserActivityAt ?? a.createdAt ?? 0),
      ),
  )

  const workspaceAttentionCount = computed(
    () => interactions.pending.filter((item) => item.presetId === quickPresetId.value).length,
  )

  const quickRoutingEnabled = computed(() => {
    const preset = presetName.value ? config.value?.presets?.[presetName.value] : undefined
    return !!preset?.shadows?.conversationRouting
  })

  watch(
    quickRoutingEnabled,
    (enabled) => {
      quickAutoMode.value = enabled
    },
    { immediate: true },
  )

  // ── 路由小窗实时状态（由 ConversationTargetPicker 经 route-status 事件上抛） ──
  const routeStatus = reactive<RouteStatus>({ routing: false, thinking: '', content: '' })

  const traceHover = ref(false)

  const traceAutoHideUntil = ref(0)

  let traceAutoHideTimer: ReturnType<typeof setTimeout> | undefined

  /** 路由结束后最终选定的目标会话 id；undefined=路由未完成/失败，null=新建对话。 */
  const finalizedTargetChatId = computed<string | null | undefined>(
    () => routeStatus.trace?.response.toolCall.arguments.chatId,
  )

  /** 目标会话是否仍存在：新建对话恒显示；历史会话若已被删除则不再展示路由小窗。 */
  const finalizedTargetStillExists = computed(() => {
    const id = finalizedTargetChatId.value
    if (id === undefined) return false
    if (id === null) return true
    return (agents.historyList ?? []).some((item) => item.chatId === id)
  })

  /** 显示：路由进行中 / 悬浮 AI 路由状态指示 / 流式结束后停留 10s（目标会话已删除则不显示）。 */
  const showTraceWindow = computed(() => {
    if (routeStatus.routing) return true
    if (!finalizedTargetStillExists.value) return false
    return traceHover.value || Date.now() < traceAutoHideUntil.value
  })

  function onRouteStatus(status: RouteStatus): void {
    const wasRouting = routeStatus.routing
    routeStatus.routing = status.routing
    routeStatus.trace = status.trace
    routeStatus.thinking = status.thinking
    routeStatus.content = status.content
    if (wasRouting && !status.routing) {
      // 流式结束：停留 10s 后自动关闭（新一轮路由/hover 会打断）。
      traceAutoHideUntil.value = Date.now() + 10_000
      if (traceAutoHideTimer) clearTimeout(traceAutoHideTimer)
      traceAutoHideTimer = setTimeout(() => {
        traceAutoHideUntil.value = 0
      }, 10_000)
    }
  }

  function onTraceHover(hover: boolean): void {
    traceHover.value = hover
  }

  // ── 发送面板可拖动（pet 无遮罩小窗，允许拖动定位） ──
  const panelEl = ref<HTMLElement | null>(null)

  const panelPos = ref<{ x: number; y: number } | null>(null)

  /** 拖拽中的边框占位框位置（fixed）；null=未在拖拽。拖动只更新它（transform 驱动，避免实时重排面板），松开后整体瞬移。 */
  const dragPreview = ref<{ x: number; y: number; w: number; h: number } | null>(null)

  let dragCtx:
    | { pointerX: number; pointerY: number; origX: number; origY: number; w: number; h: number }
    | undefined

  function bindPanelEl(el: unknown): void {
    panelEl.value =
      el instanceof HTMLElement ? el : ((el as { $el?: HTMLElement } | null)?.$el ?? null)
  }

  function onHeaderPointerDown(e: PointerEvent): void {
    const target = e.target as HTMLElement
    if (target.closest('button, input, a, [contenteditable="true"], .el-tooltip')) return
    const panel = panelEl.value
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    if (!panelPos.value) panelPos.value = { x: rect.left, y: rect.top }
    dragCtx = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      origX: panelPos.value.x,
      origY: panelPos.value.y,
      w: rect.width,
      h: rect.height,
    }
    // 拖拽中只移动边框占位框（transform 驱动，GPU 合成，不触发面板重排），松开后瞬移面板。
    dragPreview.value = { x: panelPos.value.x, y: panelPos.value.y, w: rect.width, h: rect.height }
    window.addEventListener('pointermove', onPanelPointerMove)
    window.addEventListener('pointerup', onPanelPointerUp)
    // 不可 preventDefault：会阻止 mousedown 默认的文档聚焦。失焦/切 tab 回来首次点击时，
    // 页面若得不到焦点则 Chromium 不派发后续 pointermove，导致无法拖动。
    // 拖拽中防文本选择已由 .dialog-head 的 user-select:none 承担，无需 preventDefault。
  }

  function onPanelPointerMove(e: PointerEvent): void {
    if (!dragCtx) return
    dragPreview.value = {
      x: dragCtx.origX + (e.clientX - dragCtx.pointerX),
      y: dragCtx.origY + (e.clientY - dragCtx.pointerY),
      w: dragCtx.w,
      h: dragCtx.h,
    }
  }

  function onPanelPointerUp(): void {
    const preview = dragPreview.value
    if (dragCtx && preview) {
      // 鼠标松开：面板整体瞬移到占位框位置（无过渡）。
      panelPos.value = { x: preview.x, y: preview.y }
    }
    dragPreview.value = null
    dragCtx = undefined
    window.removeEventListener('pointermove', onPanelPointerMove)
    window.removeEventListener('pointerup', onPanelPointerUp)
  }

  const panelStyle = computed<CSSProperties>(() =>
    panelPos.value
      ? {
          position: 'fixed',
          left: `${panelPos.value.x}px`,
          top: `${panelPos.value.y}px`,
          margin: '0',
        }
      : {},
  )

  /** 拖拽占位框样式：fixed + transform 跟随；width/height 在 pointerdown 时记录一次，避免拖拽中实时读布局。 */
  const dragPreviewStyle = computed(() =>
    dragPreview.value
      ? {
          position: 'fixed' as const,
          left: '0px',
          top: '0px',
          width: `${dragPreview.value.w}px`,
          height: `${dragPreview.value.h}px`,
          transform: `translate3d(${dragPreview.value.x}px, ${dragPreview.value.y}px, 0)`,
        }
      : {},
  )

  /** 路由小窗锚定在发送面板右侧；实时读面板 rect，拖动/布局变化自适应。 */
  const traceWindowPos = computed(() => {
    void panelPos.value // 面板拖动变更时触发重算；未拖动时读当前居中布局的实际 rect。
    const panel = panelEl.value
    if (!panel) return { left: '0px', top: '0px' }
    const rect = panel.getBoundingClientRect()
    return {
      left: `${Math.max(8, Math.min(rect.right + 10, window.innerWidth - 304))}px`,
      top: `${Math.max(8, rect.top)}px`,
      zIndex: ownerOverlayZIndex(panel),
    }
  })

  watch(chatId, (v) => {
    if (!v) {
      routeStatus.routing = false
      routeStatus.trace = undefined
      routeStatus.thinking = ''
      routeStatus.content = ''
      traceAutoHideUntil.value = 0
      if (traceAutoHideTimer) {
        clearTimeout(traceAutoHideTimer)
        traceAutoHideTimer = undefined
      }
    }
  })

  // AgentComposer 的 3 个 DOM ref 桥接回 useAgentDialogOptions（selectCommand / commandMenuStyle 等依赖）。
  const { commandMenuStyle, editorRefFn, commandMenuRefFn, roleMenuRefFn } = useComposerMenuPosition({
    editorRef,
    commandMenuRef,
    roleMenuRef,
    showCommandMenu,
    showRoleMenu,
        showFileMenu,
    activeCommandIndex,
    layoutDependencies: [activeCommandTab, commandOptions],
  })

  function selectQuickTarget(selection: QuickTargetSelection): void {
    if (quickTarget.value?.source === 'user' && selection.source === 'ai') return
    quickTarget.value = selection
  }

  async function sendFromComposer(): Promise<void> {
    if ((!text.value.trim() && !mediaAttachments.value.length) || sending.value || quickRoutingPending.value) return
    let targetSelection = quickTarget.value
    if (quickTargetRequired.value && targetSelection?.source !== 'user') {
      if (!quickRoutingEnabled.value || !quickAutoMode.value) {
        error.value = '请选择消息指向的目标后继续'
        return
      }
      error.value = null
      targetSelection = await targetPickerRef.value?.routeForSend(text.value)
      if (!targetSelection) {
        error.value = 'AI 未确定发送目标，请手动选择后重试'
        return
      }
    }
    let targetChatId = chatId.value ?? undefined
    if (quickTargetRequired.value) {
      if (targetSelection?.target === 'new') {
        if (!presetName.value) {
          error.value = '当前 Pet 没有关联预设'
          return
        }
        try {
          targetChatId = await agents.createMasterPet({ preset: presetName.value })
          // 'new' 是一次性目标：会话已创建即消费完毕。残留会让发送失败重试 / 下次发送
          // 再建一个新会话（本次 targetChatId 已捕获在局部变量，清空不影响本条发送）。
          quickTarget.value = undefined
          await agents.fetchHistoryList()
        } catch (cause) {
          console.error('[AgentDialog] create target session failed:', cause)
          error.value = '新建会话失败，请重试或选择一个历史会话'
          return
        }
      } else {
        targetChatId = targetSelection?.target
      }
    }
    if (targetChatId) {
      agents.activatePresetSession(quickPresetId.value, targetChatId, presetName.value)
    }
    // 发送后保持窗口打开（不关闭），路由小窗展示 Shadow Agent 工作流程。
    await handleSend(targetChatId, { keepOpen: true })
  }

  /** 打开当前会话的节点树工作台（WorkbenchDialog 多窗口，windowId = presetId）。 */
  function openWorkbenchForChat(): void {
    const preset = quickPresetId.value
    if (!preset) return
    const presetName = quickPresetName.value
    const id = agents.openWorkbenchWindow(preset, presetName)
    if (chatId.value) agents.setWorkbenchWindowChat(id, chatId.value)
  }

  /** 从待处理抽屉 @tree 打开某会话的节点树工作台。 */
  async function openWorkspaceTree(
    rootChatId: string,
    sourceChatId?: string,
    interactionId?: string,
    anchorNodeId?: string,
  ): Promise<void> {
    const preset = quickPresetId.value
    if (!preset) return
    const presetName = quickPresetName.value
    const id = agents.openWorkbenchWindow(preset, presetName)
    agents.setWorkbenchWindowChat(id, rootChatId)
    agents.setWorkbenchWindowFocus(id, {
      sourceChatId,
      interactionId,
      anchorNodeId,
    })
  }

  function closeDialog(): void {
    agents.closeAllHistory()
    closeAgentDialog()
  }

  function toggleAttention(): void {
    dialogView.value = dialogView.value === 'attention' ? 'composer' : 'attention'
  }

  function onDialogEditorKeydown(e: KeyboardEvent): void {
    onEditorKeydown(e, () => void sendFromComposer())
  }

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', onPanelPointerMove)
      window.removeEventListener('pointerup', onPanelPointerUp)
    }
    if (traceAutoHideTimer) clearTimeout(traceAutoHideTimer)
  })

  /** 颜色分级（与 SessionList / HistoryDrawerPanel / ContextBar 对齐：<50% 绿 / 50-80% 黄 / >=80% 红）。 */
  function usageClass(u: number): 'usage-low' | 'usage-mid' | 'usage-high' {
    if (u >= 0.8) return 'usage-high'
    if (u >= 0.5) return 'usage-mid'
    return 'usage-low'
  }

  /** 每角色上下文占用（按当前 brain 的 contextLimit 折算）。brain / config / pet 任一未就绪 → null（chip 隐藏）。 */
  const roleUsages = computed<Record<string, { used: number; total: number; usage: number } | null>>(
    () => {
      const p = pet.value
      const out: Record<string, { used: number; total: number; usage: number } | null> = {}
      for (const [role, sel] of Object.entries(roleSelections.value)) {
        const limit = brainConfig(sel.brain)?.contextLimit
        if (!limit || !p) {
          out[role] = null
          continue
        }
        const used = p.contextUsed ?? 0
        const usage = Math.min(1, Math.max(0, used / limit))
        out[role] = { used, total: limit, usage }
      }
      return out
    },
  )

  /** dialog-head 工作区模式：workspace 有值时 pet name 前 📁（路径失效改 ⚠ 红色），hover 显全路径。无 workspace 纯文本。 */
  const workspaceInvalid = computed(() => pet.value?.workspaceValid === false)

  return {
    ElPopover,
    ElTooltip,
    RoleConfigPopover,
    AgentComposer,
    ConversationTargetPicker,
    RoutingTraceWindow,
    WorkspaceSessionBrowser,
    ContextBreakdownTip,
    shellless,
    agents,
    interactions,
    isTopMask,
    overlayMotion,
    isFloatingOverlay,
    chatId,
    pet,
    presetName,
    brains,
    senseGroups,
    config,
    senseTools,
    roleSelections,
    primaryRole,
    text,
    editorRef,
    commandOptions,
    commandTabs,
    activeCommandTab,
    comboCommandGroups,
    showCommandMenu,
    activeCommandIndex,
    commandMenuRef,
    roleMenuRef,
    matchingRoleMentions,
    matchingFiles,
    showFileMenu,
    activeFileIndex,
    fileMenuHint,
    showRoleMenu,
    activeRoleIndex,
    uploading,
    mediaHint,
    runtimeHint,
    runtimeError,
    mediaAttachments,
    sending,
    loading,
    error,
    primarySelection,
    orderedRoleSelections,
    mediaServicesByType,
    closeAgentDialog,
    handleSend,
    onEditorKeydown,
    onEditorInput,
    onEditorSelectionChange,
    onEditorPaste,
    selectCommand,
    selectCommandTab,
    selectRoleMention,
    selectFileMention,
    removeMedia,
    toggleMediaVariant,
    onMediaSelected,
    senseEntries,
    senseTool,
    brainConfig,
    supportsTools,
    targetPickerRef,
    quickTarget,
    quickRoutingPending,
    quickAutoMode,
    setQuickRoutingPending,
    clearAiQuickTarget,
    enableAiQuickTarget,
    dialogView,
    quickTargetRequired,
    quickPresetId,
    quickPresetName,
    petWorkbenchOpen,
    dialogVisible,
    rolesExpanded,
    quickSessions,
    workspaceAttentionCount,
    quickRoutingEnabled,
    routeStatus,
    traceHover,
    traceAutoHideUntil,
    traceAutoHideTimer,
    finalizedTargetChatId,
    finalizedTargetStillExists,
    showTraceWindow,
    onRouteStatus,
    onTraceHover,
    panelEl,
    panelPos,
    dragPreview,
    dragCtx,
    bindPanelEl,
    onHeaderPointerDown,
    onPanelPointerMove,
    onPanelPointerUp,
    panelStyle,
    dragPreviewStyle,
    traceWindowPos,
    commandMenuStyle,
    editorRefFn,
    commandMenuRefFn,
    roleMenuRefFn,
    selectQuickTarget,
    sendFromComposer,
    openWorkbenchForChat,
    openWorkspaceTree,
    closeDialog,
    toggleAttention,
    onDialogEditorKeydown,
    usageClass,
    roleUsages,
    workspaceInvalid,
  }
}
