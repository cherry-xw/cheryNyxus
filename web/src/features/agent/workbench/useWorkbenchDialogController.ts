/**
 * WorkbenchDialog：节点树工作台多窗口组件（C-3 抽取）。
 * 每窗口对应一个 preset，windowId = presetId。与 AgentDialog（快速发送 composer 单例）解耦：
 *   - chatId 来源 = store workbenchWindows[windowId].chatId（不再读全局 activeDialogChatId）
 *   - 视图/几何/最小化/会话写回 store 的 setWorkbenchWindow* per-window action
 *   - useAgentDialogOptions 传 per-window chatId；useWorkbenchWindow 传 windowId（per-window localStorage key）
 * 历史抽屉（overlay）仍为全局单例（HistoryDrawer 单例渲染）；工作台自身不再打开 docked 抽屉，
 * 原「档案」能力并入整屏「对话模式」（ConversationView 复用 HistoryDrawerPanel，分支切换同步窗口会话）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { advanceComposerTurn, type ComposerTurnState } from './composerTurnState'
import { RoleConfigPopover } from '../runtime/public'
import { AgentComposer, useAgentDialogOptions, useComposerMenuPosition } from '../composer/public'
import ContextUsageBar from '../drawer/ContextUsageBar.vue'
import WorkbenchAgentUsageBar from './WorkbenchAgentUsageBar.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import PromptSnapshotTip from '../drawer/PromptSnapshotTip.vue'
import { agentApi, type RootTimelineSnapshot } from '@/application/backend/public'
import { useWorkbenchWindow, type ResizeDirection, type WorkbenchMode } from './useWorkbenchWindow'
import {
  useAgentsStore,
  useChatSessionsStore,
  useInteractionsStore,
  useTaskCatalogStore,
  useTaskOverviewStore,
} from '@/application/public'
import { CHERY_NYXUS_PRESET } from '@/domain/pets/presets'
import {
  MessageBranchTree,
  NyxusContentReader,
  type NyxusContentSelection,
} from '@/features/pets/nyxus/public'
import { resolveWorkspaceRootChatId } from '@/features/agent/attention/public'
import { NYXUS_WORKBENCH_Z_INDEX, OVERLAY_Z_INDEX } from '@/styles/overlayLayers'
import {
  ConnectionStatusChip,
  desktopBridge,
  lockWindowRootColorScheme,
  useWindowFrame,
} from '@/features/desktop/public'
import { LiteView, useLiteStore } from '@/features/lite/public'
import { useWorkbenchViewMode } from './useWorkbenchViewMode'
import { useWorkbenchContextInspector, usageClass } from './useWorkbenchContextInspector'
import { useWorkbenchAgentUsage } from './useWorkbenchAgentUsage'
import { useWorkbenchTaskController } from './useWorkbenchTaskController'
import { useWorkbenchTreeSession } from './useWorkbenchTreeSession'
import { selectTreeTimelineOverride } from './workbenchTimelineSelection'
import { matchesCurrentTask } from './useSessionStripTasks'
import { CONTEXT_ANALYTICS_DEMOS } from './context-analytics/public'
import {
  canMarkTaskResultViewed,
  taskAfterArchive,
  taskBrowserCatalogScope,
  useTaskBrowserOverlay,
} from './useTaskBrowserOverlay'
import {
  layoutModeForFoldMode,
  useWorkbenchViewPreferences,
  type FoldMode,
} from './useWorkbenchViewPreferences'

export type WorkbenchDialogControllerProps = {
  windowId: string
  presetId: string
  native?: boolean
  embedded?: boolean
}
export type { FoldMode } from './useWorkbenchViewPreferences'
export type WorkbenchSidePanel = 'none' | 'cards' | 'workflow' | 'reader'

export function useWorkbenchDialogController(props: WorkbenchDialogControllerProps) {
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  const interactions = useInteractionsStore()
  const taskCatalog = useTaskCatalogStore()
  const taskOverview = useTaskOverviewStore()
  const taskBrowser = useTaskBrowserOverlay(props.windowId)
  const taskBrowserState = taskBrowser.state
  /** 三视图模式（树 / 对话 / 精简，T33 L0 扩展）：标题栏三档切换，per-window 持久化（§2.1）。
   * Electron 面（surface=workbench）标题栏由 WindowFrame title-actions 承载，与 App.vue
   * 共用 useWorkbenchViewMode 保证各入口状态一致（native 模式 WorkbenchDialog 内部 titlebar
   * 被 v-if="!isNative" 隐藏，切换入口在 App.vue title-actions）。 */
  const liteUi = useLiteStore()
  const { viewMode, setViewMode } = useWorkbenchViewMode(props.windowId)
  /** 对话模式局部会话（per-window）：下拉切换只改本值，不影响窗口会话与树/精简视图。
   *  默认跟随窗口根会话（treeRootChatId，见下方 watch），窗口根被外部切换（标题栏等）时复位跟随。 */
  const conversationRootChatId = ref<string | null>(null)
  /** 本窗口状态（store 注册表按 windowId 索引）。窗口关闭/不存在时组件不渲染。 */
  const win = computed(() => agents.workbenchWindows[props.windowId])
  /** Phase E：需用户操作（审批/提问）时窗口闪烁。非聚焦窗由 store 置位，点击窗口熄灭。 */
  const windowBlink = computed(() => win.value?.attentionBlink ?? false)
  /** Electron 原生工作台窗面（surface=workbench）：shell 恒铺满窗口（即"全屏"），
   *  保留自身 .workbench-titlebar 逐像素外观，只换驱动层（OS 拖拽 + windowControl 三键）。
   *  浏览器 overlay 路径（native=false）逐字节不变。 */
  const isNative = computed(() => !!props.native && !!desktopBridge())
  const isEmbedded = computed(() => !!props.embedded && !isNative.value)
  const isShellless = computed(() => isNative.value || isEmbedded.value)
  /** 原生窗最大化态回推（双击标题栏 / Win+↑ / 拖边缘）；非 Electron 下恒 false（no-op）。 */
  const { maximized: nativeMaximized, control: nativeWindowControl } = useWindowFrame()
  /** 生效窗口模式：native 恒全屏（窗口即画布）；浏览器跟随 useWorkbenchWindow 持久化模式。 */
  const effectiveMode = computed<WorkbenchMode>(() =>
    isShellless.value ? 'fullscreen' : workbenchMode.value,
  )
  /** 最大化键显示态：native 跟随原生窗最大化回推，浏览器跟随 workbench 模式。 */
  const maxControlState = computed(() => {
    if (isNative.value) return nativeMaximized.value ? 'restore' : 'maximize'
    return workbenchMode.value === 'fullscreen' ? 'restore' : 'maximize'
  })
  /** 点击标题栏即视为用户已注意到该窗口 → 熄灭闪烁。 */
  function onTitlePointerDown(e: PointerEvent): void {
    agents.setWorkbenchWindowBlink(props.windowId, false)
    // native 面：拖拽归 OS（-webkit-app-region: drag），不进入 pointer 拖
    if (isNative.value) return
    workbenchWindow.onTitlePointerDown(e)
  }
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
    handleSend,
    onEditorKeydown,
    onEditorInput,
    onEditorSelectionChange,
    onEditorPaste,
    selectCommand,
    selectCommandTab,
    selectRoleMention,
    selectFileMention,
    appendFileReference,
    resetEditor,
    resetMedia,
    removeMedia,
    toggleMediaVariant,
    onMediaSelected,
    senseEntries,
    senseTool,
    brainConfig,
    supportsTools,
  } = useAgentDialogOptions({
    draftScope: `workbench:${props.windowId}`,
    chatId: () => win.value?.chatId ?? null,
    // 入口携带的预设名：空白工作台/会话未水合时角色编制、Nyxus 判定据此解析（不靠会话推导）
    presetName: () => win.value?.presetName ?? null,
  })
  const isNyxus = computed(() => presetName.value === CHERY_NYXUS_PRESET)
  const workbenchWindow = useWorkbenchWindow({
    windowId: props.windowId,
    managed: !isShellless.value,
  })
  const {
    shellRef: workbenchShellRef,
    mode: workbenchMode,
    position: workbenchPosition,
    size: workbenchSize,
    shellStyle: workbenchShellStyle,
  } = workbenchWindow
  const resizeDirections: ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']
  // 几何写回 store（useWorkbenchWindow 本地 ref 为渲染源，store 为持久快照）。
  watch(
    () => [
      workbenchMode.value,
      workbenchPosition.value.x,
      workbenchPosition.value.y,
      workbenchSize.value.width,
      workbenchSize.value.height,
    ],
    () => {
      // native 面几何由原生窗管理（main 进程持久化 bounds），本窗 store 记录不写
      if (isShellless.value) return
      agents.setWorkbenchWindowGeometry(props.windowId, {
        mode: workbenchMode.value,
        position: { x: workbenchPosition.value.x, y: workbenchPosition.value.y },
        size: { width: workbenchSize.value.width, height: workbenchSize.value.height },
      })
    },
    { immediate: true },
  )
  let workbenchResizeObserver: ResizeObserver | undefined
  /** rail 悬浮面板（角色/会话列表）宽高上限改为相对工作台窗口：窗口化工作台下
   *  100vw/100vh 会超出窗口被 .workbench-shell overflow:hidden 裁剪（见 WorkbenchDialog.scoped.less）。 */
  function syncRailPopoutBounds(): void {
    const shell = workbenchShellRef.value
    if (!shell) return
    const rect = shell.getBoundingClientRect()
    shell.style.setProperty('--rail-popout-w', `${Math.max(0, rect.width - 190)}px`)
    shell.style.setProperty('--rail-popout-h', `${Math.max(0, rect.height - 128)}px`)
  }
  watch(workbenchShellRef, (element) => {
    workbenchResizeObserver?.disconnect()
    if (!element) return
    workbenchResizeObserver = new ResizeObserver(() => {
      syncRailPopoutBounds()
    })
    workbenchResizeObserver.observe(element)
    void nextTick(() => {
      syncRailPopoutBounds()
    })
  })
  // ── quick target（Pet 打开非 Nyxus 工作台需显式目标；Nyxus 恒 false） ──
  interface QuickTargetSelection {
    target: string | 'new'
    source: 'ai' | 'user'
    confidence?: number
  }
  const quickTarget = ref<QuickTargetSelection>()
  // 切会话清残留目标（与 AgentDialog 同约定，见 docs/shared/protocol/interactions.md chat.route.suggest）。
  // 当前 quickTarget 无 UI 写入口恒 undefined，纯防御未来接入目标选择器时不复现残留 bug。
  watch(chatId, () => {
    quickTarget.value = undefined
  })
  const quickRoutingPending = ref(false)
  const quickRoutingWaiters: Array<() => void> = []
  async function waitForQuickRouting(): Promise<void> {
    if (!quickRoutingPending.value) return
    await new Promise<void>((resolve) => quickRoutingWaiters.push(resolve))
  }
  const quickPresetId = computed(() => props.presetId)
  const quickTargetRequired = computed(
    () => agents.activeDialogSource === 'pet' && !isNyxus.value && !!presetName.value,
  )
  const nyxusDraftActive = ref(false)
  const userClosedAfterTurn = ref(false)
  let composerTurn: ComposerTurnState = { active: false, awaitingInput: false }
  /** 只持久化折叠档位；辅助侧栏每次进入工作台默认关闭，避免隐式建立 workflow lease。 */
  const { foldMode } = useWorkbenchViewPreferences(props.presetId)
  const sidePanel = ref<WorkbenchSidePanel>('none')
  const selectedContent = ref<NyxusContentSelection>()
  const replayTimeline = shallowRef<RootTimelineSnapshot>()
  const branchTarget = ref<{
    type: 'detail' | 'continuation'
    nodeId: string
    sourceRootChatId: string
    effectDigest?: string
  }>()
  const {
    controlTimeline: liveTimeline,
    executeSessionControl,
    pauseWholeTask,
    sessionControl,
    sessionControlPending,
    taskControlPending,
    taskHasRunningBranches,
    taskTimeline,
  } = useWorkbenchTaskController({ chatId, windowId: props.windowId })
  const readerTimeline = computed(() => replayTimeline.value ?? liveTimeline.value)

  function selectWorkflowContent(selection: NyxusContentSelection): void {
    selectedContent.value = selection
    sidePanel.value = 'reader'
  }

  function toggleSidePanel(panel: Exclude<WorkbenchSidePanel, 'none'>): void {
    sidePanel.value = sidePanel.value === panel ? 'none' : panel
  }

  /** 右侧抽屉标题（卡牌/流程图/阅读器，与 档案 抽屉同款头部）。 */
  const sidePanelTitle = computed(() =>
    sidePanel.value === 'cards' ? '卡牌模式' : sidePanel.value === 'workflow' ? '流程图' : '阅读器',
  )
  /** 关闭侧边抽屉（MessageBranchTree 右侧抽屉 ✕ / 遮罩触发）。 */
  function closeSidePanel(): void {
    sidePanel.value = 'none'
  }

  function updateReplayTimeline(payload: {
    replay: boolean
    timeline?: RootTimelineSnapshot
  }): void {
    replayTimeline.value = payload.replay ? payload.timeline : undefined
  }
  const detailBranchAvailability = computed(() => {
    const loaded = config.value
    const preset = presetName.value ? loaded?.presets?.[presetName.value] : undefined
    if (!preset?.detailRole)
      return { available: false, reason: '当前预设未指定解释角色，请在预设成员卡中设置。' }
    if (!(preset.roles ?? []).includes(preset.detailRole))
      return { available: false, reason: '解释角色必须是当前预设成员。' }
    const detail = loaded?.roles?.[preset.detailRole]
    return detail?.kind !== 'shadow' && detail?.brain && detail.senseGroup
      ? { available: true, reason: '' }
      : { available: false, reason: '解释角色配置不完整，请在角色设置中配置大脑和器官组。' }
  })
  const hasPresetWorkspace = computed(() => {
    const preset = presetName.value ? config.value?.presets?.[presetName.value] : undefined
    return Boolean(preset?.workspace?.trim())
  })
  const composerBranchTitle = computed(() =>
    branchTarget.value?.type === 'detail'
      ? '解释所选节点'
      : branchTarget.value?.type === 'continuation'
        ? '从所选节点继续'
        : '发送新消息',
  )
  const composerBranchDescription = computed(() =>
    branchTarget.value?.type === 'detail'
      ? '使用专用诊断角色创建独立解释分支，不影响原任务'
      : branchTarget.value?.type === 'continuation'
        ? '继承原角色创建并列任务分支，既有工具副作用不会撤销'
        : '发送后将作为新节点加入当前会话',
  )
  async function selectBranchTarget(payload: {
    type: 'detail' | 'continuation'
    nodeId: string
    sourceRootChatId: string
    ordinary?: boolean
  }): Promise<void> {
    if (payload.ordinary) {
      branchTarget.value = undefined
      nyxusDraftActive.value = true
      error.value = null
      void nextTick(() => editorRef.value?.focus())
      return
    }
    const sourceRootChatId = payload.sourceRootChatId
    try {
      const preview = await agentApi.previewBranch(sourceRootChatId, payload.nodeId)
      if (!preview.eligible) throw new Error(preview.reason || '该节点不能发起分支')
      if (payload.type === 'continuation' && preview.sideEffects.length) {
        const summary = preview.sideEffects
          .slice(0, 8)
          .map((effect) => `• ${effect.toolName}`)
          .join('\n')
        await ElMessageBox.confirm(
          `所选节点之后已有 ${preview.sideEffects.length} 个工具调用产生结果，这些副作用不会被撤销。\n\n${summary}`,
          '从此处继续',
          { confirmButtonText: '确认创建并列分支', cancelButtonText: '取消', type: 'warning' },
        )
      }
      branchTarget.value = {
        type: payload.type,
        nodeId: payload.nodeId,
        sourceRootChatId,
        effectDigest: preview.effectDigest,
      }
      nyxusDraftActive.value = true
      void nextTick(() => editorRef.value?.focus())
    } catch (cause) {
      if (cause === 'cancel' || cause === 'close') return
      ElMessage.error(cause instanceof Error ? cause.message : '无法从该节点发起分支')
    }
  }
  /** 折叠四档控件：hover 时按钮自身变宽，左侧滑出 4 个子按钮，点击切换档位。 */
  const foldToolOpen = ref(false)
  interface FoldIconDefinition {
    paths: readonly string[]
    nodes: ReadonlyArray<readonly [number, number]>
  }
  /** 同一棵树由完整到主线逐档减重，图形密度与投影的精简程度保持一致。 */
  const FOLD_ICONS: Record<FoldMode, FoldIconDefinition> = {
    none: {
      paths: ['M12 3v18', 'M12 6 5 9v7l7 3', 'M12 8l7 3v6l-7 3'],
      nodes: [
        [12, 3],
        [12, 6],
        [5, 9],
        [5, 12.5],
        [5, 16],
        [19, 11],
        [19, 14],
        [19, 17],
        [12, 19],
        [12, 21],
      ],
    },
    partial: {
      paths: ['M12 3v18', 'M12 7 6 10v6l6 3', 'M12 9l6 3'],
      nodes: [
        [12, 3],
        [12, 7],
        [6, 10],
        [6, 16],
        [18, 12],
        [12, 19],
        [12, 21],
      ],
    },
    participant: {
      paths: ['M12 3v18', 'M12 8 6 12', 'M12 8l6 4'],
      nodes: [
        [12, 3],
        [12, 8],
        [6, 12],
        [18, 12],
        [12, 21],
      ],
    },
    full: {
      paths: ['M12 3v18'],
      nodes: [
        [12, 3],
        [12, 12],
        [12, 21],
      ],
    },
  }
  const FOLD_TIPS: Record<FoldMode, string> = {
    none: '完整展示：显示全部节点与分支',
    partial: '局部收纳：收起同一参与者已完成的连续步骤',
    participant: '按参与者收纳：保留任务交接与结果返回关系',
    full: '只看每轮主线：保留用户消息、分支起点与最终回复',
  }
  let foldCloseTimer: ReturnType<typeof setTimeout> | undefined
  function showFoldTool(): void {
    if (foldCloseTimer) clearTimeout(foldCloseTimer)
    foldCloseTimer = undefined
    foldToolOpen.value = true
  }
  function scheduleFoldToolClose(): void {
    if (foldCloseTimer) clearTimeout(foldCloseTimer)
    foldCloseTimer = setTimeout(() => {
      foldToolOpen.value = false
      foldCloseTimer = undefined
    }, 160)
  }
  function selectFoldMode(mode: FoldMode): void {
    foldMode.value = mode
  }
  const roleListOpen = ref(false)
  /** 角色列表配置交互期间锁定：点击内部控件（select 等）时置位，防 hover 误关。 */
  const roleListPinned = ref(false)
  let roleListCloseTimer: ReturnType<typeof setTimeout> | undefined
  // AgentComposer 的 3 个 DOM ref 桥接回 useAgentDialogOptions（selectCommand / commandMenuStyle 等依赖）。
  const { commandMenuStyle, editorRefFn, commandMenuRefFn, roleMenuRefFn } =
    useComposerMenuPosition({
      editorRef,
      commandMenuRef,
      roleMenuRef,
      showCommandMenu,
      showRoleMenu,
      showFileMenu,
      activeCommandIndex,
      layoutDependencies: [activeCommandTab, commandOptions],
    })

  // ── 角色列表（参照钢琴 popout：hover/click 展开、延迟关闭、交互期间锁定） ──
  function showRoleList(): void {
    if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
    roleListCloseTimer = undefined
    agents.closeAllHistory()
    roleListOpen.value = true
  }
  function scheduleRoleListClose(): void {
    if (roleListPinned.value) return
    if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
    roleListCloseTimer = setTimeout(() => {
      roleListOpen.value = false
      roleListCloseTimer = undefined
    }, 160)
  }
  function closeRoleList(): void {
    if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
    roleListCloseTimer = undefined
    roleListPinned.value = false
    roleListOpen.value = false
  }
  function toggleRoleList(): void {
    if (roleListOpen.value) closeRoleList()
    else showRoleList()
  }
  /** 点击身份卡弹出层/按钮之外 → 关闭角色配置。 */
  function onRoleOutsidePointerDown(e: PointerEvent): void {
    const t = e.target as HTMLElement | null
    if (t?.closest('.nyxus-role-popout') || t?.closest('.nyxus-role-tool')) return
    closeRoleList()
  }
  watch(roleListOpen, (open) => {
    if (open) window.addEventListener('pointerdown', onRoleOutsidePointerDown)
    else window.removeEventListener('pointerdown', onRoleOutsidePointerDown)
  })
  // ── 会话列表已移除（2026-09-16）：切换入口上移标题栏会话状态条（strip + 当前预设分页下拉），
  // rail ≡ popout 及其数据路径（rootSessions/onSessionDelete）一并删除，见 docs/frontend/workbench-multi-window.md。
  function activateNyxusInput(): void {
    userClosedAfterTurn.value = false
    nyxusDraftActive.value = true
    void nextTick(() => editorRef.value?.focus())
  }
  function cancelNyxusInput(): void {
    if (sending.value) return
    nyxusDraftActive.value = false
    userClosedAfterTurn.value = true
    branchTarget.value = undefined
    resetEditor()
    resetMedia()
    error.value = null
  }
  /** 右侧消息按钮 toggle：输入区开着时点击关闭，关着时点击打开。 */
  function toggleNyxusInput(): void {
    if (nyxusDraftActive.value) cancelNyxusInput()
    else activateNyxusInput()
  }
  async function sendFromComposer(): Promise<void> {
    if (sending.value || uploading.value || loading.value) return
    if (quickTargetRequired.value && quickRoutingPending.value) await waitForQuickRouting()
    if (quickTargetRequired.value && !quickTarget.value) {
      error.value = '请选择消息指向的目标后继续'
      return
    }
    nyxusDraftActive.value = false
    userClosedAfterTurn.value = false
    if (branchTarget.value) {
      if (mediaAttachments.value.length) {
        error.value = '分支暂不支持附件，请移除附件或返回普通输入后发送。'
        nyxusDraftActive.value = true
        return
      }
      const target = branchTarget.value
      const prompt = text.value.trim()
      if (!prompt) {
        error.value = '请输入要在新分支中继续的内容'
        nyxusDraftActive.value = true
        return
      }
      sending.value = true
      try {
        const created = await agentApi.createBranch({
          rootChatId: target.sourceRootChatId,
          anchorNodeId: target.nodeId,
          branchType: target.type,
          prompt,
          commandId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          ...(target.type === 'continuation' ? { effectDigest: target.effectDigest } : {}),
        })
        branchTarget.value = undefined
        resetEditor()
        resetMedia()
        // 仅 continuation 切换工作台会话/树（成为新主流程）；detail 不切换，只作为轻量子分支留在当前树上。
        if (target.type === 'continuation') {
          agents.setWorkbenchWindowChat(props.windowId, created.chatId)
          treeRootChatId.value = created.chatId
        }
        try {
          taskTimeline.value = await agentApi.getTaskTimeline({
            taskId: created.taskId,
            view: 'tree',
          })
        } catch (cause) {
          ElMessage.warning(`分支已创建，但时间线刷新失败：${(cause as Error).message}`)
        }
        await chatSessions.openSession(created.chatId).catch(() => undefined)
        return
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '创建分支失败'
        nyxusDraftActive.value = true
        return
      } finally {
        sending.value = false
      }
    }
    // 对话模式下发送目标 = 下拉选中的局部会话（conversationRootChatId，可能不是窗口根/主流程）；
    // 树/精简模式仍以窗口会话 chatId 为准。
    let targetChatId =
      (viewMode.value === 'conversation' ? conversationRootChatId.value : undefined) ??
      chatId.value ??
      undefined
    if (quickTargetRequired.value) {
      if (quickTarget.value?.target === 'new') {
        if (!presetName.value) {
          error.value = '当前 Pet 没有关联预设'
          return
        }
        try {
          targetChatId = await agents.createMasterPet({ preset: presetName.value })
          // 'new' 一次性消费：会话已创建即清空，防残留导致下次发送再建（AgentDialog 同约定，
          // 见 docs/shared/protocol/interactions.md chat.route.suggest）。当前 quickTarget 无 UI 写入口，纯防御。
          quickTarget.value = undefined
          await agents.fetchHistoryList()
        } catch (cause) {
          console.error('[WorkbenchDialog] create target session failed:', cause)
          error.value = '新建会话失败，请重试或选择一个历史会话'
          return
        }
      } else {
        targetChatId = quickTarget.value?.target
      }
    }
    // 对话模式局部会话发送：目标 = 下拉选中的会话（conversationRootChatId，可能不是窗口根/主流程）。
    // 此时不得把窗口会话/预设活跃根一并改走（树/精简不受影响），否则下拉切换的局部性失效。
    const isConversationLocalSend =
      viewMode.value === 'conversation' &&
      !!conversationRootChatId.value &&
      conversationRootChatId.value !== chatId.value
    if (targetChatId && !isConversationLocalSend) {
      agents.activatePresetSession(quickPresetId.value, targetChatId, presetName.value)
      agents.setWorkbenchWindowChat(props.windowId, targetChatId)
    }
    await handleSend(targetChatId, { keepOpen: true })
    if (text.value) nyxusDraftActive.value = true
  }
  /** 任意入口（标题栏三档切换钮；rail「对话模式」按钮 v2.1 移除）离开对话模式都清理代际二层视图。
   *  从对话模式切回节点树时打开输入区：对话模式常驻输入框，切回后允许继续输入。 */
  watch(viewMode, (mode, previousMode) => {
    if (mode !== 'conversation') agents.closeHistoryGeneration()
    // 从对话模式切回节点树且已有会话：打开输入区，允许继续输入。
    if (mode === 'tree' && previousMode === 'conversation' && treeRootChatId.value) {
      userClosedAfterTurn.value = false
      nyxusDraftActive.value = true
    }
  })
  /** 对话模式级联切换（分支/会话）：只改对话模式局部会话（conversationRootChatId），
   *  不影响窗口会话与树/精简视图（窗口根仍由标题栏/任务浏览器等入口切换）。 */
  function onConversationSwitchChat(cid: string): void {
    if (!cid || cid === conversationRootChatId.value) return
    conversationRootChatId.value = cid
  }
  /** 对话模式输入框草稿写入：与树 composer 共用 text 事实源（树端打开时经 restoreEditor 回填）。 */
  function onConversationDraftInput(value: string): void {
    text.value = value
  }
  /** 丢弃对话模式输入框上的分支目标（只清目标，不动草稿/附件）。 */
  function clearBranchTarget(): void {
    branchTarget.value = undefined
  }
  const {
    connection,
    createSession,
    creating,
    releaseCurrentRoot,
    switchSession,
    treeFocusInteractionId,
    treeFocusNonce,
    treeFocusSourceChatId,
    treeLoading,
    treeLoadError,
    retryTree,
    treeRootChatId,
  } = useWorkbenchTreeSession({
    windowId: props.windowId,
    presetId: props.presetId,
    presetName,
    isNyxus,
    chatId,
    taskTimeline,
    resetComposerBranch: () => {
      branchTarget.value = undefined
    },
    resetDraft: () => {
      nyxusDraftActive.value = false
    },
    setError: (message) => {
      error.value = message
    },
  })
  /** 新建会话后默认打开输入区（新会话/复用空会话都允许继续输入并聚焦）；
   *  创建失败（error 被新设置）时不打开，保留错误提示。 */
  async function handleCreateSession(): Promise<void> {
    const errorBefore = error.value
    await createSession()
    if (error.value && error.value !== errorBefore) return
    await nextTick()
    userClosedAfterTurn.value = false
    nyxusDraftActive.value = true
    void nextTick(() => editorRef.value?.focus())
  }
  /** 对话模式局部会话跟随窗口根：下拉切换只改 conversationRootChatId（treeRootChatId 不变），
   *  此处仅在窗口根被外部切换（标题栏/任务浏览器/归档等）时同步，保证对话模式不滞留已离开的会话。 */
  watch(
    treeRootChatId,
    (rootChatId) => {
      if (conversationRootChatId.value !== rootChatId) conversationRootChatId.value = rootChatId
    },
    { immediate: true },
  )
  /** 对话模式实际展示的会话（渲染期非空：conversationViewVisible 由窗口根 treeRootChatId 门控，
   *  本值同步跟随，下拉局部切换时用局部值）。 */
  const conversationViewChatId = computed<string>(
    () => conversationRootChatId.value ?? treeRootChatId.value ?? '',
  )
  const documentForeground = ref(false)
  const resultViewInFlight = new Set<string>()
  let taskBrowserReturnFocus: HTMLElement | null = null
  let skipTaskBrowserFocusRestore = false

  function syncDocumentForeground(): void {
    documentForeground.value = document.visibilityState === 'visible' && document.hasFocus()
  }

  const workbenchForeground = computed(
    () => documentForeground.value && !!win.value?.focused && !win.value.minimized,
  )

  watch(
    () => taskBrowserState.value.open,
    async (open) => {
      if (open) {
        taskBrowserReturnFocus = document.activeElement as HTMLElement | null
        skipTaskBrowserFocusRestore = false
        return
      }
      if (skipTaskBrowserFocusRestore) {
        skipTaskBrowserFocusRestore = false
        taskBrowserReturnFocus = null
        return
      }
      const target = taskBrowserReturnFocus
      taskBrowserReturnFocus = null
      await nextTick()
      if (target?.isConnected) target.focus()
    },
  )

  function closeTaskBrowser(): void {
    taskBrowser.close()
  }

  async function openTaskFromBrowser(targetChatId: string): Promise<void> {
    skipTaskBrowserFocusRestore = true
    await switchSession(targetChatId)
    taskBrowser.close()
  }

  function onTaskBrowserArchived(
    taskKey: string,
    archivedChatIds: string[],
    activeChatIdAtStart?: string,
  ): void {
    const followup = taskAfterArchive({
      tasks: taskOverview.tasks,
      taskKey,
      archivedChatIds,
      activeChatIdAtStart,
      currentChatId: chatId.value,
      presetId: props.presetId,
      presetName: presetName.value ?? undefined,
    })
    if (followup.change) agents.setWorkbenchWindowChat(props.windowId, followup.chatId)
  }

  watch(
    () => {
      const task = taskOverview.tasks.find((candidate) =>
        matchesCurrentTask(candidate, chatId.value ?? undefined),
      )
      return [
        task?.taskKey,
        task?.latestResult?.resultId,
        task?.unreadResult,
        chatId.value,
        treeRootChatId.value,
        treeLoading.value,
        workbenchForeground.value,
        taskBrowserState.value.open,
      ] as const
    },
    async () => {
      const task = taskOverview.tasks.find((candidate) =>
        matchesCurrentTask(candidate, chatId.value ?? undefined),
      )
      const gate = {
        task,
        currentChatId: chatId.value,
        loadedChatId: treeRootChatId.value,
        loading: treeLoading.value,
        foreground: workbenchForeground.value,
        taskBrowserOpen: taskBrowserState.value.open,
      }
      if (!canMarkTaskResultViewed(gate)) return
      const resultId = gate.task.latestResult.resultId
      const requestKey = `${gate.task.taskKey}:${resultId}`
      if (resultViewInFlight.has(requestKey)) return
      resultViewInFlight.add(requestKey)
      try {
        const viewed = await taskCatalog.markResultViewed(
          gate.task.taskKey,
          resultId,
          taskBrowserCatalogScope(props.windowId, props.presetId, presetName.value ?? undefined),
        )
        if (viewed) taskOverview.acknowledgeResultViewed(gate.task.taskKey, resultId)
      } catch (cause) {
        console.warn('[WorkbenchDialog] mark task result viewed failed:', cause)
      } finally {
        resultViewInFlight.delete(requestKey)
      }
    },
    { immediate: true },
  )
  const attentionRootChatId = computed(() =>
    resolveWorkspaceRootChatId(liveTimeline.value?.rootChatId, treeRootChatId.value),
  )
  const workspacePending = computed(() =>
    interactions.pending.filter(
      (item) => !!attentionRootChatId.value && item.rootChatId === attentionRootChatId.value,
    ),
  )
  const currentAttentionCount = computed(() => workspacePending.value.length)
  /** 其他工作区的待处理数量；标题栏铃铛入口打开统一审核窗口。 */
  const attentionCount = computed(
    () => interactions.pending.filter((item) => item.rootChatId !== attentionRootChatId.value).length,
  )
  const workspaceBrowserOpen = ref(false)
  // 独立保存审核窗口的显示状态，切换树/对话/经典模式时不重置。
  const attentionSurfaceInitialized = ref(false)
  watch(
    currentAttentionCount,
    (count) => {
      if (count <= 0) {
        attentionSurfaceInitialized.value = false
        return
      }
      if (attentionSurfaceInitialized.value) return
      attentionSurfaceInitialized.value = true
      workspaceBrowserOpen.value = true
    },
    { immediate: true },
  )
  function closeWorkspaceBrowser(): void {
    workspaceBrowserOpen.value = false
  }
  function toggleWorkspaceBrowser(): void {
    workspaceBrowserOpen.value = !workspaceBrowserOpen.value
    agents.setWorkbenchWindowBlink(props.windowId, false)
    void interactions.refresh().catch(() => undefined)
  }
  function onTreeInteractionFocus(_focus: {
    chatId: string
    interactionId?: string
    anchorNodeId?: string
  }): void {
    workspaceBrowserOpen.value = true
    agents.setWorkbenchWindowBlink(props.windowId, false)
    void interactions.refresh().catch(() => undefined)
  }
  async function focusAttentionTree(
    rootChatId: string,
    sourceChatId?: string,
    interactionId?: string,
    anchorNodeId?: string,
  ): Promise<void> {
    closeWorkspaceBrowser()
    if (rootChatId && rootChatId !== treeRootChatId.value) await switchSession(rootChatId)
    const targetId = anchorNodeId ?? interactionId
    if (!targetId) return
    treeFocusSourceChatId.value = sourceChatId ?? rootChatId
    treeFocusInteractionId.value = targetId
    treeFocusNonce.value++
    selectWorkflowContent({ nodeId: targetId, sourceChatId: sourceChatId ?? rootChatId })
  }
  watch(chatId, () => {
    composerTurn = { active: false, awaitingInput: false }
    userClosedAfterTurn.value = false
  })
  watch(
    () =>
      [
        liveTimeline.value?.activeRuns.some(
          (run) => run.status === 'running' || run.status === 'waiting',
        ) ?? false,
        currentAttentionCount.value,
      ] as const,
    ([active, attention]) => {
      const next = advanceComposerTurn(composerTurn, {
        active,
        pending: attention,
        dismissed: userClosedAfterTurn.value,
      })
      composerTurn = next.state
      if (next.resetDismissal) userClosedAfterTurn.value = false
      if (next.open) nyxusDraftActive.value = true
    },
    { immediate: true },
  )

  watch(
    [attentionRootChatId, () => connection.status],
    ([rootChatId, status]) => {
      if (!rootChatId || status !== 'connected') return
      void interactions
        .refresh()
        .catch((cause) => console.warn('[WorkbenchDialog] refresh interactions failed:', cause))
    },
    { immediate: true },
  )

  /** 从阅读器/树打开某代打包历史：切入对话模式并在整屏会话视图打开该代二层视图。
   *  ConversationView 面板 watch agents.historyDrawerGeneration（rootChatId 匹配 + group 布局）加载。 */
  function openGeneration(generationIndex: number): void {
    const rootChatId = liveTimeline.value?.rootChatId ?? treeRootChatId.value
    if (!rootChatId) return
    setViewMode('conversation')
    agents.openHistoryGeneration(rootChatId, generationIndex)
  }

  watch(
    () => readerTimeline.value?.rootChatId,
    (rootChatId, previousRootChatId) => {
      if (!rootChatId || !previousRootChatId || rootChatId === previousRootChatId) return
      selectedContent.value = undefined
      replayTimeline.value = undefined
    },
  )
  /** 精简模式可见（lite 紧凑会话视图）；创建新会话后自动进入（既有契约，见下）。 */
  const liteViewVisible = computed(() => viewMode.value === 'lite' && !!treeRootChatId.value)
  /** 对话模式可见：整屏会话视图（ConversationView）替代节点树主画布。 */
  const conversationViewVisible = computed(
    () => viewMode.value === 'conversation' && !!treeRootChatId.value,
  )
  /** 对话模式注入的任务分支摘要（面板级联切换与任务身份解析用；与旧 openHistory 注入同源）。 */
  // 对话模式的下拉必须读取任务级快照；当前根实时时间线只包含一个根，
  // 不能作为同一任务其它 Agent/分支的选项来源。
  const conversationTaskBranches = computed(() => liveTimeline.value?.branches ?? [])
  function closeWorkbench(): void {
    if (sending.value) return
    taskBrowser.close()
    // 工作台不持有 docked 历史抽屉（对话模式为整屏视图，随窗销毁），overlay 全局抽屉不受影响。
    error.value = null
    // 只清理本窗口的 Lite 草稿/展开/滚动等 UI state；canonical root 数据与其它窗口不动。
    liteUi.clearWindow(props.windowId)
    if (isNative.value) {
      // 原生窗：释放本窗根时间线订阅后交 main 关闭（工作台窗 close=hide，任务继续、WS 保持）
      releaseCurrentRoot()
      nativeWindowControl('close')
      return
    }
    agents.closeWorkbenchWindow(props.windowId)
    releaseCurrentRoot()
  }
  function minimizeWorkbench(): void {
    if (isNative.value) {
      nativeWindowControl('minimize')
      return
    }
    // 最小化不改焦点（2026-09-03 胶囊移除）：缩后窗不保持 focused，任务栏 tag 高亮才不失真；
    // setWorkbenchWindowMinimized 内部联动 minimizeWorkspaceWindow 把焦点转移给下一个可见窗。
    agents.setWorkbenchWindowMinimized(props.windowId, true)
  }
  /** 最大化/还原：native 走原生窗（main 处理，回推更新图标）；浏览器切 workbench 模式。 */
  function onMaximizeClick(): void {
    if (isNative.value) {
      nativeWindowControl(nativeMaximized.value ? 'restore' : 'maximize')
      return
    }
    workbenchWindow.toggleMode()
  }
  function onDialogEditorKeydown(e: KeyboardEvent): void {
    if (
      nyxusDraftActive.value &&
      e.key === 'Escape' &&
      !showFileMenu.value &&
      !showCommandMenu.value &&
      !showRoleMenu.value
    ) {
      e.preventDefault()
      e.stopPropagation()
      cancelNyxusInput()
      return
    }
    onEditorKeydown(e, () => void sendFromComposer())
  }
  // ── 斜杠指令菜单定位（Teleport 到 body 后用 fixed 定位；锚定 .msg-input 顶部，向上展开） ──
  onMounted(() => {
    // native 面（无 WindowFrame 外壳）：锁定根画布 color-scheme + 加 window-surface class（灰边修复）
    if (isNative.value) lockWindowRootColorScheme()
    syncDocumentForeground()
    window.addEventListener('focus', syncDocumentForeground)
    window.addEventListener('blur', syncDocumentForeground)
    document.addEventListener('visibilitychange', syncDocumentForeground)
  })
  onBeforeUnmount(() => {
    workbenchResizeObserver?.disconnect()
    if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
    if (foldCloseTimer) clearTimeout(foldCloseTimer)
    window.removeEventListener('pointerdown', onRoleOutsidePointerDown)
    window.removeEventListener('focus', syncDocumentForeground)
    window.removeEventListener('blur', syncDocumentForeground)
    document.removeEventListener('visibilitychange', syncDocumentForeground)
    taskBrowser.dispose()
  })
  const {
    onTreeEpochChange,
    onTreePromptSnapShow,
    roleUsages,
    treeBreakdown,
    treePromptSnap,
    treeUsage,
    treeUsagePct,
  } = useWorkbenchContextInspector({
    treeRootChatId,
    pet,
    roleSelections,
    brainConfig,
  })

  // 工作台底部 Agent 用量条：主 Agent + 子 Agent 的 token 上下文、耗时与运行状态（树/对话/精简三视图共用）。
  const agentUsage = useWorkbenchAgentUsage({
    rootChatId: treeRootChatId,
    agentName: presetName,
    runtime: primarySelection,
    brainConfig,
    usage: treeUsage,
    breakdown: treeBreakdown,
  })

  // 查看上下文侧边抽屉：rail ❐ 按钮点击开关（原小弹窗空间不足，改为工作台右缘抽屉）。
  // 打开时立即按当前树根会话拉取提示词快照；关闭不清数据，再次打开按 key 去重不重复请求。
  const contextDrawerOpen = ref(false)
  const contextAnalyticsInitialTaskKey = ref<string>()
  const contextAnalyticsDemos = CONTEXT_ANALYTICS_DEMOS
  const contextAnalyticsForced = ref(false)
  const contextAnalyticsAvailable = computed(() => {
    return !!treeRootChatId.value
  })
  function toggleContextDrawer(): void {
    if (!contextAnalyticsAvailable.value) return
    if (!contextDrawerOpen.value) {
      contextAnalyticsForced.value = false
      const currentTask = taskOverview.tasks.find((candidate) =>
        matchesCurrentTask(candidate, chatId.value ?? undefined),
      )
      contextAnalyticsInitialTaskKey.value =
        currentTask?.taskKey ?? treeRootChatId.value ?? undefined
    }
    contextDrawerOpen.value = !contextDrawerOpen.value
  }
  function openContextAnalyticsFromBrowser(taskKey: string): void {
    contextAnalyticsForced.value = true
    contextAnalyticsInitialTaskKey.value = taskKey
    contextDrawerOpen.value = true
  }
  function closeContextDrawer(): void {
    contextDrawerOpen.value = false
    contextAnalyticsForced.value = false
  }
  const contextAnalyticsPanelEligible = computed(
    () => contextAnalyticsForced.value || contextAnalyticsAvailable.value,
  )
  watch(contextAnalyticsAvailable, (available) => {
    if (!available && contextDrawerOpen.value && !contextAnalyticsForced.value) closeContextDrawer()
  })

  const runtimeDiagramProps = computed(() => ({
    chatId: treeRootChatId.value,
    timeline: liveTimeline.value,
    foldMode: foldMode.value,
    selection: selectedContent.value,
    focusSourceChatId: treeFocusSourceChatId.value,
    focusInteractionId: treeFocusInteractionId.value,
    focusNonce: treeFocusNonce.value,
    suspended: win.value?.minimized ?? false,
    pendingCount: currentAttentionCount.value,
    onSelectContent: selectWorkflowContent,
    onReplayTimelineChange: updateReplayTimeline,
  }))
  const treeProps = computed(() => ({
    rootChatId: treeRootChatId.value,
    timelineOverride: selectTreeTimelineOverride(
      treeRootChatId.value ? chatSessions.rootTimeline(treeRootChatId.value, 'tree') : undefined,
      taskTimeline.value,
    ),
    layoutMode: layoutModeForFoldMode(foldMode.value),
    presentationMode: 'horizontal-signal' as const,
    foldMode: foldMode.value,
    paperMode: sidePanel.value === 'cards',
    sidePanelOpen: sidePanel.value !== 'none',
    sidePanelTitle: sidePanelTitle.value,
    suspended: win.value?.minimized ?? false,
    focusSourceChatId: treeFocusSourceChatId.value,
    focusInteractionId: treeFocusInteractionId.value,
    fullRenderThreshold: agents.globalConfig?.global.tree_full_render_threshold,
    branchAnchorNodeId: branchTarget.value?.nodeId,
    branchAnchorKind: branchTarget.value?.type,
    detailBranchAvailable: detailBranchAvailability.value.available,
    detailBranchUnavailableReason: detailBranchAvailability.value.reason,
  }))

  return {
    runtimeDiagramProps,
    treeProps,
    MessageBranchTree,
    AgentComposer,
    ConnectionStatusChip,
    ContextUsageBar,
    WorkbenchAgentUsageBar,
    FOLD_ICONS,
    FOLD_TIPS,
    LiteView,
    NYXUS_WORKBENCH_Z_INDEX,
    NyxusContentReader,
    OVERLAY_Z_INDEX,
    PromptSnapshotTip,
    RoleConfigPopover,
    activateNyxusInput,
    activeCommandIndex,
    activeCommandTab,
    activeRoleIndex,
    agents,
    attentionCount,
    attentionRootChatId,
    closeWorkspaceBrowser,
    currentAttentionCount,
    brains,
    branchTarget,
    cancelNyxusInput,
    chatId,
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
    createSession: handleCreateSession,
    creating,
    detailBranchAvailability,
    editorRefFn,
    effectiveMode,
    error,
    executeSessionControl,
    fmtTokens,
    foldMode,
    foldToolOpen,
    focusAttentionTree,
    isNative,
    isEmbedded,
    isShellless,
    isNyxus,
    liteViewVisible,
    conversationViewVisible,
    conversationTaskBranches,
    conversationRootChatId,
    conversationViewChatId,
    liveTimeline,
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
    onConversationSwitchChat,
    onConversationDraftInput,
    clearBranchTarget,
    onDialogEditorKeydown,
    onEditorInput,
    onEditorPaste,
    onEditorSelectionChange,
    onMaximizeClick,
    onMediaSelected,
    onTitlePointerDown,
    onTreeInteractionFocus,
    onTreeEpochChange,
    onTreePromptSnapShow,
    openGeneration,
    orderedRoleSelections,
    pauseWholeTask,
    presetName,
    primaryRole,
    primarySelection,
    quickPresetId,
    ref,
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
    replayTimeline,
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
    appendFileReference,
    sendFromComposer,
    sending,
    senseEntries,
    senseGroups,
    senseTool,
    senseTools,
    sessionControl,
    sessionControlPending,
    showCommandMenu,
    showFoldTool,
    showRoleList,
    showRoleMenu,
    closeSidePanel,
    closeContextDrawer,
    contextAnalyticsDemos,
    contextAnalyticsAvailable,
    contextAnalyticsPanelEligible,
    contextAnalyticsInitialTaskKey,
    contextDrawerOpen,
    toggleContextDrawer,
    toggleWorkspaceBrowser,
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
    treeFocusInteractionId,
    treeFocusNonce,
    treeFocusSourceChatId,
    treeLoading,
    treeLoadError,
    treePromptSnap,
    treeRootChatId,
    retryTree,
    treeUsage,
    treeUsagePct,
    workspaceBrowserOpen,
    hasPresetWorkspace,
    agentUsage,
    updateReplayTimeline,
    uploading,
    usageClass,
    win,
    windowBlink,
    viewMode,
    workbenchShellRef,
    workbenchShellStyle,
    workbenchWindow,
  }
}
