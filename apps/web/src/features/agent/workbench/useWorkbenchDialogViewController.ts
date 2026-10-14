import { defineAsyncComponent, computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BellFilled, Reading } from '@element-plus/icons-vue'
import ConversationView from './ConversationView.vue'
import WorkbenchAttentionSurface from './WorkbenchAttentionSurface.vue'
import WorkbenchOfflineMask from './WorkbenchOfflineMask.vue'
const TaskBrowser = defineAsyncComponent(() => import('./TaskBrowser.vue'))
import {
  useWorkbenchDialogController,
  type WorkbenchDialogControllerProps,
} from './useWorkbenchDialogController'
import { useOverlayTransitionHooks } from '@/composables/useOverlayAnimation'
import { useAgentsStore } from '@/application/public'
import WorkbenchViewToggle from './WorkbenchViewToggle.vue'
import WorkbenchAttentionIndicator from './WorkbenchAttentionIndicator.vue'
import WorkbenchFoldTool from './WorkbenchFoldTool.vue'
import WorkbenchWindowControls from './WorkbenchWindowControls.vue'
const ContextAnalyticsPanel = defineAsyncComponent(() => import('./context-analytics/ContextAnalyticsPanel.vue'))
const WorkbenchFilesWorkspace = defineAsyncComponent(() => import('./files/WorkbenchFilesWorkspace.vue'))
import { serializeFileMention } from '../composables/commands'

export function useWorkbenchDialogViewController(props: Readonly<WorkbenchDialogControllerProps>, emit: (event: 'filesOpenChange', open: boolean) => void) {
  const controller = useWorkbenchDialogController(props)

  const agents = useAgentsStore()

  const workbenchMotion = useOverlayTransitionHooks('dialog')

  const rolePopoutMotion = useOverlayTransitionHooks('panel')

  // 查看上下文侧边抽屉：drawer 型动效（面板 x 轴滑入，与全局抽屉一致）。
  const contextDrawerMotion = useOverlayTransitionHooks('drawer')

  const contextTrigger = ref<HTMLButtonElement>()

  const filesOpen = ref(false)

  const visitedFileChat = ref('')

  watch([filesOpen, controller.treeRootChatId], ([open, id]) => {
    if (open) visitedFileChat.value = id
  })

  const liteViewRef = ref<{ insertReference: (token: string) => void }>()

  const conversationViewRef = ref<{ focusInput: () => void }>()

  const roleStackRef = ref<HTMLElement>()

  const hoveredRole = ref<string>()

  const roleStackHeight = ref(0)

  const roleStackPositions = ref<number[]>([])

  /** 卡片下移后与上一张卡片底部保留的重叠高度：消除悬停空白带（防止指针同时离开两张卡导致弹回闪烁），取小量不影响内容展示。 */
  const ROLE_STACK_OVERLAP = 8

  let roleStackResizeObserver: ResizeObserver | undefined

  function roleStackRoleIndex(role: string): number {
    return controller.orderedRoleSelections.value.findIndex(([name]) => name === role)
  }

  const activeRoleStackIndex = computed(() =>
    hoveredRole.value ? roleStackRoleIndex(hoveredRole.value) : -1,
  )

  function setRoleStackHover(role: string): void {
    hoveredRole.value = role
    void nextTick(updateRoleStackLayout)
  }

  function clearRoleStackHover(role: string): void {
    if (hoveredRole.value !== role) return
    hoveredRole.value = undefined
    void nextTick(updateRoleStackLayout)
  }

  function updateRoleStackLayout(): void {
    const stack = roleStackRef.value
    if (!stack) return
    const items = Array.from(stack.querySelectorAll<HTMLElement>('.role-stack-item'))
    if (!items.length) {
      roleStackHeight.value = 0
      roleStackPositions.value = []
      return
    }
  
    const peek = stack.querySelector<HTMLElement>('.role-stack-nameplate')?.offsetHeight ?? 32
    const positions = Array<number>(items.length).fill(0)
    const active = activeRoleStackIndex.value
    const activeHeight = active >= 0 ? (items[active]?.offsetHeight ?? 0) : 0
    // 下移距离 = 本卡高度 − peek（扇形偏移）− 小量重叠：让前面卡片正好停在本卡底部并保留小量重叠，
    // 不留空隙，避免指针同时离开两张卡。相比旧式"大幅下移"消除了中间空白带。
    const expandedDistance = active >= 0 ? Math.max(0, activeHeight - peek - ROLE_STACK_OVERLAP) : 0
  
    // 默认位置：Y 轴从上到下为 C → B → A（A 最前/上层，C 最后/下层），每张卡露出上半部分头部。
    // 悬浮某张卡时，只把它之前的卡片向 Y 轴下方移动（贴合本卡底部，留小量重叠）；
    // 当前卡片和后面的卡片不移动，离开后恢复默认位置。
    positions.forEach((_, index) => {
      positions[index] = (items.length - 1 - index) * peek + (index < active ? expandedDistance : 0)
    })
    roleStackPositions.value = positions
    roleStackHeight.value = Math.max(
      ...items.map((item, index) => (positions[index] ?? 0) + item.offsetHeight),
    )
  }

  function roleStackItemStyle(index: number): Record<string, string> {
    return {
      transform: `translateY(${roleStackPositions.value[index] ?? 0}px)`,
      // 层级只由卡片原始顺序决定：A 在最上层，C 在最下层；悬浮时只能改变 Y 轴位置。
      zIndex: String(100 - index),
    }
  }

  watch(
    () => [controller.loading.value, controller.orderedRoleSelections.value.length],
    () => {
      void nextTick(() => {
        roleStackResizeObserver?.disconnect()
        const stack = roleStackRef.value
        if (!stack) return
        roleStackResizeObserver = new ResizeObserver(updateRoleStackLayout)
        stack.querySelectorAll<HTMLElement>('.role-stack-item').forEach((item) => {
          roleStackResizeObserver?.observe(item)
        })
        updateRoleStackLayout()
      })
    },
  )

  watch(controller.roleListOpen, (open) => {
    if (open) {
      void nextTick(() => {
        roleStackResizeObserver?.disconnect()
        const stack = roleStackRef.value
        if (!stack) return
        roleStackResizeObserver = new ResizeObserver(updateRoleStackLayout)
        stack.querySelectorAll<HTMLElement>('.role-stack-item').forEach((item) => {
          roleStackResizeObserver?.observe(item)
        })
        updateRoleStackLayout()
      })
    } else {
      hoveredRole.value = undefined
      roleStackResizeObserver?.disconnect()
    }
  })

  onMounted(() => window.addEventListener('resize', updateRoleStackLayout))

  onBeforeUnmount(() => {
    window.removeEventListener('resize', updateRoleStackLayout)
    roleStackResizeObserver?.disconnect()
  })

  function insertFileReference(path: string, kind: 'file' | 'directory'): void {
    const token = serializeFileMention({ path, kind })
    const targetIsLite = liteViewVisible.value
    filesOpen.value = false
    if (targetIsLite) void nextTick(() => liteViewRef.value?.insertReference(token))
    else {
      controller.appendFileReference({ path, kind })
      if (conversationViewVisible.value) void nextTick(() => conversationViewRef.value?.focusInput())
      else activateNyxusInput()
    }
  }

  function closeContextPanel(): void {
    controller.closeContextDrawer()
    void nextTick(() => contextTrigger.value?.focus())
  }

  function toggleFilesWorkspace(): void {
    if (!controller.treeRootChatId.value) return
    filesOpen.value = !filesOpen.value
    emit('filesOpenChange', filesOpen.value)
  }

  function onFilesTriggerClick(): void {
    closeTaskBrowser()
    toggleFilesWorkspace()
  }

  function closeFilesWorkspace(): void {
    filesOpen.value = false
    emit('filesOpenChange', false)
  }

  // 抽屉打开时按 Esc 关闭。topOverlay 守卫与全局抽屉一致：settings / 历史抽屉 / 输入弹窗 /
  // 会话列表任一打开时它们在上方，Esc 交给它们处理，避免双重关闭。
  function onContextDrawerKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !controller.contextDrawerOpen.value) return
    if (agents.topOverlay) return
    e.preventDefault()
    e.stopImmediatePropagation()
    closeContextPanel()
  }

  onMounted(() => window.addEventListener('keydown', onContextDrawerKeydown, true))

  onBeforeUnmount(() => window.removeEventListener('keydown', onContextDrawerKeydown, true))

  // 小组角色编制入口统一在右侧 rail 按钮（树/对话/精简三视图共用），composer 内不再内置折叠面板。
  // Keep the controller surface grouped here so this orchestration SFC stays inside its line budget.
  // prettier-ignore
  const {
    AgentComposer, ConnectionStatusChip, ContextUsageBar, WorkbenchAgentUsageBar,
    FOLD_ICONS, FOLD_TIPS,
    LiteView,
    MessageBranchTree,
    NYXUS_WORKBENCH_Z_INDEX,
    NyxusContentReader,
    OVERLAY_Z_INDEX, PromptSnapshotTip, RoleConfigPopover,
    activateNyxusInput, activeCommandIndex, activeCommandTab, activeRoleIndex,
    attentionCount, attentionRootChatId, attentionSurfaceOpen, closeWorkspaceBrowser, currentAttentionCount, focusAttentionTree,
    treeProps,
    brains, branchTarget,
    cancelNyxusInput, chatId, clearBranchTarget, closeWorkbench,
    comboCommandGroups,
    commandMenuRefFn, commandMenuStyle,
    commandOptions, commandTabs,
    composerBranchDescription, composerBranchTitle,
    config, connection,
    conversationTaskBranches, conversationViewVisible, conversationViewChatId,
    createSession, creating, detailBranchAvailability,
    editorRefFn, effectiveMode, error, executeSessionControl,
    foldMode, foldToolOpen,
    isEmbedded, isShellless, liteViewVisible, loading,
    matchingRoleMentions,
    matchingFiles, showFileMenu, activeFileIndex, fileMenuHint,
    maxControlState,
    mediaAttachments, mediaHint,
    runtimeHint, runtimeError,
    mediaServicesByType, minimizeWorkbench, nyxusDraftActive,
    onConversationDraftInput,
    onConversationSwitchChat,
    onDialogEditorKeydown,
    onEditorInput,
    onEditorPaste,
    onEditorSelectionChange,
    onMaximizeClick,
    onMediaSelected,
    onTitlePointerDown,
    onTreeInteractionFocus,
    onTreeEpochChange,
    openGeneration, orderedRoleSelections, pauseWholeTask,
    presetName, primaryRole, primarySelection, removeMedia, resizeDirections,
    roleListOpen, roleListPinned, roleMenuRefFn,
    roleSelections, roleUsages,
    sidePanel, toggleSidePanel,
    toggleMediaVariant,
    toggleNyxusInput,
    readerTimeline,
    scheduleFoldToolClose, scheduleRoleListClose,
    selectBranchTarget, selectedContent, selectWorkflowContent,
    selectCommand, selectCommandTab, selectFoldMode, selectRoleMention,
    selectFileMention,
    sendFromComposer, sending,
    senseGroups, senseTools,
    sessionControl, sessionControlPending,
    showCommandMenu, showFoldTool, showRoleList, showRoleMenu,
    closeSidePanel,
    contextAnalyticsInitialTaskKey,
    contextDrawerOpen, contextAnalyticsAvailable, contextAnalyticsPanelEligible, toggleContextDrawer,
     toggleWorkspaceBrowser,
     hasPresetWorkspace,
    supportsTools,
    taskControlPending, taskHasRunningBranches, taskTimeline,
    taskBrowserState, closeTaskBrowser, openContextAnalyticsFromBrowser, openTaskFromBrowser, onTaskBrowserArchived,
    text, toggleRoleList,
    treeBreakdown, treeLoading, treeLoadError, treePromptSnap, treeRootChatId, retryTree,
    treeUsage, treeUsagePct,
  
    uploading, win, windowBlink,
    agentUsage,
    workbenchShellRef, workbenchShellStyle, workbenchWindow,
  } = controller

  // 底部 Agent 用量条入参：顶层解构为独立 ref，模板中才能自动解包。
   const { agents: usageBarAgents, tokenSpeed: usageBarTokenSpeed, taskElapsedMs: usageTaskElapsedMs } = agentUsage

  return {
    BellFilled,
    Reading,
    ConversationView,
    WorkbenchAttentionSurface,
    WorkbenchOfflineMask,
    TaskBrowser,
    WorkbenchViewToggle,
    WorkbenchAttentionIndicator,
    WorkbenchFoldTool,
    WorkbenchWindowControls,
    ContextAnalyticsPanel,
    WorkbenchFilesWorkspace,
    controller,
    agents,
    workbenchMotion,
    rolePopoutMotion,
    contextDrawerMotion,
    contextTrigger,
    filesOpen,
    visitedFileChat,
    liteViewRef,
    conversationViewRef,
    roleStackRef,
    hoveredRole,
    roleStackHeight,
    roleStackPositions,
    ROLE_STACK_OVERLAP,
    roleStackResizeObserver,
    roleStackRoleIndex,
    activeRoleStackIndex,
    setRoleStackHover,
    clearRoleStackHover,
    updateRoleStackLayout,
    roleStackItemStyle,
    insertFileReference,
    closeContextPanel,
    toggleFilesWorkspace,
    onFilesTriggerClick,
    closeFilesWorkspace,
    onContextDrawerKeydown,
    AgentComposer,
    ConnectionStatusChip,
    ContextUsageBar,
    WorkbenchAgentUsageBar,
    FOLD_ICONS,
    FOLD_TIPS,
    LiteView,
    MessageBranchTree,
    NYXUS_WORKBENCH_Z_INDEX,
    NyxusContentReader,
    OVERLAY_Z_INDEX,
    PromptSnapshotTip,
    RoleConfigPopover,
    activateNyxusInput,
    activeCommandIndex,
    activeCommandTab,
    activeRoleIndex,
    attentionCount,
    attentionRootChatId,
    attentionSurfaceOpen,
    closeWorkspaceBrowser,
    currentAttentionCount,
    focusAttentionTree,
    treeProps,
    brains,
    branchTarget,
    cancelNyxusInput,
    chatId,
    clearBranchTarget,
    closeWorkbench,
    comboCommandGroups,
    commandMenuRefFn,
    commandMenuStyle,
    commandOptions,
    commandTabs,
    composerBranchDescription,
    composerBranchTitle,
    config,
    connection,
    conversationTaskBranches,
    conversationViewVisible,
    conversationViewChatId,
    createSession,
    creating,
    detailBranchAvailability,
    editorRefFn,
    effectiveMode,
    error,
    executeSessionControl,
    foldMode,
    foldToolOpen,
    isEmbedded,
    isShellless,
    liteViewVisible,
    loading,
    matchingRoleMentions,
    matchingFiles,
    showFileMenu,
    activeFileIndex,
    fileMenuHint,
    maxControlState,
    mediaAttachments,
    mediaHint,
    runtimeHint,
    runtimeError,
    mediaServicesByType,
    minimizeWorkbench,
    nyxusDraftActive,
    onConversationDraftInput,
    onConversationSwitchChat,
    onDialogEditorKeydown,
    onEditorInput,
    onEditorPaste,
    onEditorSelectionChange,
    onMaximizeClick,
    onMediaSelected,
    onTitlePointerDown,
    onTreeInteractionFocus,
    onTreeEpochChange,
    openGeneration,
    orderedRoleSelections,
    pauseWholeTask,
    presetName,
    primaryRole,
    primarySelection,
    removeMedia,
    resizeDirections,
    roleListOpen,
    roleListPinned,
    roleMenuRefFn,
    roleSelections,
    roleUsages,
    sidePanel,
    toggleSidePanel,
    toggleMediaVariant,
    toggleNyxusInput,
    readerTimeline,
    scheduleFoldToolClose,
    scheduleRoleListClose,
    selectBranchTarget,
    selectedContent,
    selectWorkflowContent,
    selectCommand,
    selectCommandTab,
    selectFoldMode,
    selectRoleMention,
    selectFileMention,
    sendFromComposer,
    sending,
    senseGroups,
    senseTools,
    sessionControl,
    sessionControlPending,
    showCommandMenu,
    showFoldTool,
    showRoleList,
    showRoleMenu,
    closeSidePanel,
    contextAnalyticsInitialTaskKey,
    contextDrawerOpen,
    contextAnalyticsAvailable,
    contextAnalyticsPanelEligible,
    toggleContextDrawer,
    toggleWorkspaceBrowser,
    hasPresetWorkspace,
    supportsTools,
    taskControlPending,
    taskHasRunningBranches,
    taskTimeline,
    taskBrowserState,
    closeTaskBrowser,
    openContextAnalyticsFromBrowser,
    openTaskFromBrowser,
    onTaskBrowserArchived,
    text,
    toggleRoleList,
    treeBreakdown,
    treeLoading,
    treeLoadError,
    treePromptSnap,
    treeRootChatId,
    retryTree,
    treeUsage,
    treeUsagePct,
    uploading,
    win,
    windowBlink,
    agentUsage,
    workbenchShellRef,
    workbenchShellStyle,
    workbenchWindow,
    usageBarAgents,
    usageBarTokenSpeed,
    usageTaskElapsedMs,
  }
}
