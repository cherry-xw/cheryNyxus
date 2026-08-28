/**
 * WorkbenchDialog：节点树工作台多窗口组件（C-3 抽取）。
 * 每窗口对应一个 preset，windowId = presetId。与 AgentDialog（快速发送 composer 单例）解耦：
 *   - chatId 来源 = store workbenchWindows[windowId].chatId（不再读全局 activeDialogChatId）
 *   - 视图/几何/最小化/会话写回 store 的 setWorkbenchWindow* per-window action
 *   - useAgentDialogOptions 传 per-window chatId；useWorkbenchWindow 传 windowId（per-window localStorage key）
 * 历史抽屉仍为全局单例（HistoryDrawer 单例渲染），openHistory/锚点写全局 agents.historyDrawer*。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElMessage, ElMessageBox } from 'element-plus'
import { RoleConfigPopover } from '../runtime/public'
import { AgentComposer, useAgentDialogOptions, useComposerMenuPosition } from '../composer/public'
import { PendingOperationsPanel } from '../attention/public'
import ContextUsageBar from '../drawer/ContextUsageBar.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import PromptSnapshotTip from '../drawer/PromptSnapshotTip.vue'
import { agentApi, type ChatSummary } from '@/application/backend/public'
import { useWorkbenchWindow, type ResizeDirection, type WorkbenchMode } from './useWorkbenchWindow'
import { useAgentsStore, useChatSessionsStore } from '@/application/public'
import { CHERY_NYXUS_PRESET } from '@/domain/pets/presets'
import { MessageBranchTree, NyxusPianoStrip, isPianoRootSession } from '@/features/pets/nyxus/public'
import { NYXUS_WORKBENCH_Z_INDEX, OVERLAY_Z_INDEX } from '@/styles/overlayLayers'
import {
  ConnectionStatusChip,
  desktopBridge,
  lockWindowRootColorScheme,
  useWindowFrame,
} from '@/features/desktop/public'
import { LiteView, useLiteStore } from '@/features/lite/public'
import { useLiteViewToggle } from './useLiteViewToggle'
import { useWorkbenchContextInspector, usageClass } from './useWorkbenchContextInspector'
import { useWorkbenchTaskController } from './useWorkbenchTaskController'
import { useWorkbenchTreeSession } from './useWorkbenchTreeSession'
import NyxusSessionList from './NyxusSessionList.vue'
import { useWorkbenchViewPreferences, type FoldMode } from './useWorkbenchViewPreferences'

export type WorkbenchDialogControllerProps = {
  windowId: string
  presetId: string
  native?: boolean
}
export type { FoldMode } from './useWorkbenchViewPreferences'

export function useWorkbenchDialogController(props: WorkbenchDialogControllerProps) {
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  /** lite 极简视图（T33 L0 + native 入口修复）：标题栏 ⚡ 切换，per-window 持久化（§2.1）。
   * Electron 面（surface=workbench）标题栏由 WindowFrame title-actions 承载，与 App.vue
   * 共用 useLiteViewToggle 保证两模式状态一致（native 模式 WorkbenchDialog 内部 titlebar
   * 被 v-if="!isNative" 隐藏，切换入口在 App.vue title-actions）。 */
  const liteUi = useLiteStore()
  const { liteViewEnabled, toggleLiteView } = useLiteViewToggle(props.windowId)
  /** 本窗口状态（store 注册表按 windowId 索引）。窗口关闭/不存在时组件不渲染。 */
  const win = computed(() => agents.workbenchWindows[props.windowId])
  /** Phase E：需用户操作（审批/提问）时窗口闪烁。非聚焦窗由 store 置位，点击窗口熄灭。 */
  const windowBlink = computed(() => win.value?.attentionBlink ?? false)
  /** Electron 原生工作台窗面（surface=workbench）：shell 恒铺满窗口（即"全屏"），
   *  保留自身 .workbench-titlebar 逐像素外观，只换驱动层（OS 拖拽 + windowControl 三键）。
   *  浏览器 overlay 路径（native=false）逐字节不变。 */
  const isNative = computed(() => !!props.native && !!desktopBridge())
  /** 原生窗最大化态回推（双击标题栏 / Win+↑ / 拖边缘）；非 Electron 下恒 false（no-op）。 */
  const { maximized: nativeMaximized, control: nativeWindowControl } = useWindowFrame()
  /** 生效窗口模式：native 恒全屏（窗口即画布）；浏览器跟随 useWorkbenchWindow 持久化模式。 */
  const effectiveMode = computed<WorkbenchMode>(() =>
    isNative.value ? 'fullscreen' : workbenchMode.value,
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
  const MotionDiv = motion.div
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
    showRoleMenu,
    activeRoleIndex,
    uploading,
    mediaHint,
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
    resetEditor,
    resetMedia,
    removeMedia,
    onMediaSelected,
    senseEntries,
    senseTool,
    brainConfig,
    supportsTools,
  } = useAgentDialogOptions({
    chatId: () => win.value?.chatId ?? null,
    // 入口携带的预设名：空白工作台/会话未水合时角色编制、Nyxus 判定据此解析（不靠会话推导）
    presetName: () => win.value?.presetName ?? null,
  })
  const isNyxus = computed(() => presetName.value === CHERY_NYXUS_PRESET)
  const workbenchWindow = useWorkbenchWindow({ windowId: props.windowId })
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
      if (isNative.value) return
      agents.setWorkbenchWindowGeometry(props.windowId, {
        mode: workbenchMode.value,
        position: { x: workbenchPosition.value.x, y: workbenchPosition.value.y },
        size: { width: workbenchSize.value.width, height: workbenchSize.value.height },
      })
    },
    { immediate: true },
  )
  /** 节点树实例 ref：最大化/窗口切换时显式触发复位，确保画布按新视口重排（RO 对瞬时全屏切换并不可靠）。 */
  const branchTreeRef = ref<{ resetLayout: () => void } | null>(null)
  function workbenchDrawerAnchor() {
    const rect = workbenchShellRef.value?.getBoundingClientRect()
    if (!rect) return null
    // 从标题栏下方起始、铺满内容区全宽，使历史抽屉盖住右侧 rail 按钮；标题栏窗口控制按钮保持可用。
    // native 面（Electron 原生窗）标题栏由 WindowFrame 外壳承载在 shell 之外，shell 顶部即内容区
    // 顶部，不再偏移；浏览器面自绘标题栏（40px）在 shell 内，需下移标题栏高。
    const TITLEBAR_H = isNative.value ? 0 : 40
    return {
      top: rect.top + TITLEBAR_H,
      left: rect.left,
      width: rect.width,
      height: Math.max(0, rect.height - TITLEBAR_H),
    }
  }
  function syncWorkbenchDrawerAnchor(): void {
    if (agents.historyDrawerMode !== 'workbench-docked') return
    agents.updateHistoryDrawerAnchor(workbenchDrawerAnchor())
  }
  let workbenchResizeObserver: ResizeObserver | undefined
  watch(workbenchShellRef, (element) => {
    workbenchResizeObserver?.disconnect()
    if (!element) return
    workbenchResizeObserver = new ResizeObserver(syncWorkbenchDrawerAnchor)
    workbenchResizeObserver.observe(element)
    void nextTick(syncWorkbenchDrawerAnchor)
  })
  watch(
    [
      workbenchMode,
      () => workbenchPosition.value.x,
      () => workbenchPosition.value.y,
      () => workbenchSize.value.width,
      () => workbenchSize.value.height,
    ],
    () => void nextTick(syncWorkbenchDrawerAnchor),
  )
  // 最大化/窗口切换（shell 尺寸瞬时变化）显式复位节点树画布，避免相机停留在旧视口导致画布未铺满/下边截断。
  watch(
    [workbenchMode, () => workbenchSize.value.width, () => workbenchSize.value.height],
    () => void nextTick(() => branchTreeRef.value?.resetLayout()),
  )
  // ── quick target（Pet 打开非 Nyxus 工作台需显式目标；Nyxus 恒 false） ──
  interface QuickTargetSelection {
    target: string | 'new'
    source: 'ai' | 'user'
    confidence?: number
  }
  const quickTarget = ref<QuickTargetSelection>()
  // 切会话清残留目标（与 AgentDialog 同约定，见 docs/interaction.md chat.route.suggest）。
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
  /** 当前预设的工作台布局与折叠偏好；右侧按钮选择写入前端本地存储。 */
  const { topologyLayout, foldMode, paperMode } = useWorkbenchViewPreferences(props.presetId)
  const branchTarget = ref<{
    type: 'detail' | 'continuation'
    nodeId: string
    sourceRootChatId: string
    effectDigest?: string
  }>()
  const {
    executeSessionControl,
    pauseWholeTask,
    sessionControl,
    sessionControlPending,
    taskControlPending,
    taskHasRunningBranches,
    taskTimeline,
  } = useWorkbenchTaskController({ chatId, windowId: props.windowId })
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
    partial: '局部精简：折叠连续过程，保留必要返回节点',
    participant: '关键分支：精简各 Agent 过程，保留分派与返回关系',
    full: '极简主线：每轮只保留用户消息与最终回复',
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
  const pianoOpen = ref(false)
  const roleListOpen = ref(false)
  /** 角色列表配置交互期间锁定：点击内部控件（select 等）时置位，防 hover 误关。 */
  const roleListPinned = ref(false)
  let roleListCloseTimer: ReturnType<typeof setTimeout> | undefined
  /** 会话列表 popout 状态（仿角色列表：hover/click 展开、延迟关闭、交互期间锁定）。 */
  const sessionListOpen = ref(false)
  let sessionListCloseTimer: ReturnType<typeof setTimeout> | undefined
  // AgentComposer 的 3 个 DOM ref 桥接回 useAgentDialogOptions（selectCommand / commandMenuStyle 等依赖）。
  const { commandMenuStyle, editorRefFn, commandMenuRefFn, roleMenuRefFn } =
    useComposerMenuPosition({
      editorRef,
      commandMenuRef,
      roleMenuRef,
      showCommandMenu,
      showRoleMenu,
      activeCommandIndex,
      layoutDependencies: [activeCommandTab, commandOptions],
    })

  /** 彩蛋浮层打开：收起会话/角色 popout + 历史抽屉，置位浮层可见性。 */
  function openPiano(): void {
    closeSessionList()
    closeRoleList()
    agents.closeAllHistory()
    pianoOpen.value = true
  }
  function closePiano(): void {
    pianoOpen.value = false
  }
  /** 节点树彩蛋连点序列触发 → 打开钢琴浮层。 */
  function onEasterEgg(): void {
    openPiano()
  }
  // ── 角色列表（参照钢琴 popout：hover/click 展开、延迟关闭、交互期间锁定） ──
  function showRoleList(): void {
    if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
    roleListCloseTimer = undefined
    // 与会话列表互斥：展开角色列表时收起会话列表。
    closeSessionList()
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
  /** 点击 popout/按钮之外 → 关闭（配置面板点外部关闭）。 */
  function onRoleOutsidePointerDown(e: PointerEvent): void {
    const t = e.target as HTMLElement | null
    if (t?.closest('.nyxus-role-popout') || t?.closest('.nyxus-role-tool')) return
    closeRoleList()
  }
  watch(roleListOpen, (open) => {
    if (open) window.addEventListener('pointerdown', onRoleOutsidePointerDown)
    else window.removeEventListener('pointerdown', onRoleOutsidePointerDown)
  })
  // ── 会话列表（仿角色列表 popout：hover/click 展开、延迟关闭、互斥） ──
  function showSessionList(): void {
    if (sessionListCloseTimer) clearTimeout(sessionListCloseTimer)
    sessionListCloseTimer = undefined
    closeRoleList()
    agents.closeAllHistory()
    sessionListOpen.value = true
  }
  function scheduleSessionListClose(): void {
    if (sessionListCloseTimer) clearTimeout(sessionListCloseTimer)
    sessionListCloseTimer = setTimeout(() => {
      sessionListOpen.value = false
      sessionListCloseTimer = undefined
    }, 160)
  }
  function closeSessionList(): void {
    if (sessionListCloseTimer) clearTimeout(sessionListCloseTimer)
    sessionListCloseTimer = undefined
    sessionListOpen.value = false
  }
  function toggleSessionList(): void {
    if (sessionListOpen.value) closeSessionList()
    else showSessionList()
  }
  /** 点击 popout/按钮之外 → 关闭会话列表。 */
  function onSessionOutsidePointerDown(e: PointerEvent): void {
    const t = e.target as HTMLElement | null
    if (t?.closest('.nyxus-session-popout') || t?.closest('.nyxus-session-tool')) return
    closeSessionList()
  }
  watch(sessionListOpen, (open) => {
    if (open) window.addEventListener('pointerdown', onSessionOutsidePointerDown)
    else window.removeEventListener('pointerdown', onSessionOutsidePointerDown)
  })
  /** 会话列表数据：按需拉取全部 root 会话（history scope 全量 + includePreview），前端按预设过滤。
   * 不用 scope:'preset' + presetId/preset——后端 listRootChatsForPresets（src/db/chat.ts）对 metadata
   * 原始字段精确匹配，会话 metadata 带非空 presetId 且与 props.presetId 不一致时双分支均 false，
   * 曾致列表全空（2026-08-26 实测 bug）；也不复用 agents.historyList——它来自 scope:'stage'，
   * 每预设仅保留最新 1 个 root（src/service/chat/handler.ts latestByPreset）且 lean 不带 preview，
   * 既列不出历史会话、preview/turnCount 也恒空。history scope 走 listAllChats() 全量返回，
   * 由下方 rootSessions 按预设过滤（与旧版 proven 逻辑一致）。 */
  const sessionListChats = ref<ChatSummary[]>([])
  const sessionListLoading = ref(false)
  async function refreshSessionList(): Promise<void> {
    sessionListLoading.value = true
    try {
      const chats = await agentApi.listChats({
        scope: 'history',
        includePreview: true,
      })
      sessionListChats.value = chats
    } catch (cause) {
      console.warn('[WorkbenchDialog] 会话列表拉取失败:', cause)
      // 失败回退 stage 目录（agents.historyList），保证列表不空。
      sessionListChats.value = agents.historyList ?? []
    } finally {
      sessionListLoading.value = false
    }
  }
  /** 打开时刷新一次（hover/click 均经 open 变 true 触发，不重复拉取）。 */
  watch(sessionListOpen, (open) => {
    if (open) void refreshSessionList()
  })
  const rootSessions = computed<ChatSummary[]>(() =>
    sessionListChats.value
      .filter(
        (c) =>
          isPianoRootSession(c) && (c.preset === presetName.value || c.presetId === props.presetId),
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
  )
  async function onSessionDelete(targetChatId: string): Promise<void> {
    // Deletion prunes the active workbench chat before the request resolves, so preserve intent now.
    const deletingActiveSession = targetChatId === chatId.value
    try {
      if (isNyxus.value) await deleteNyxusSession(targetChatId)
      else await deletePresetSession(targetChatId)
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '删除会话失败')
      return
    }
    // Do not override a session the user selected while deletion was in flight.
    if (deletingActiveSession && !chatId.value) {
      const latest = rootSessions.value.find((session) => session.chatId !== targetChatId)?.chatId
      if (latest) await switchSession(latest)
      else agents.setWorkbenchWindowChat(props.windowId, null)
    }
    void refreshSessionList()
  }
  function activateNyxusInput(): void {
    nyxusDraftActive.value = true
    void nextTick(() => editorRef.value?.focus())
  }
  function cancelNyxusInput(): void {
    if (sending.value) return
    nyxusDraftActive.value = false
    branchTarget.value = undefined
    resetEditor()
    resetMedia()
    error.value = null
  }
  async function sendFromComposer(): Promise<void> {
    if (quickTargetRequired.value && quickRoutingPending.value) await waitForQuickRouting()
    if (quickTargetRequired.value && !quickTarget.value) {
      error.value = '请选择消息指向的目标后继续'
      return
    }
    nyxusDraftActive.value = false
    if (branchTarget.value) {
      const target = branchTarget.value
      const prompt = text.value.trim()
      if (!prompt) {
        error.value = '请输入要在新分支中继续的内容'
        nyxusDraftActive.value = true
        return
      }
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
        taskTimeline.value = await agentApi.getTaskTimeline({
          taskId: created.taskId,
          view: 'tree',
        })
        await chatSessions.openSession(created.chatId).catch(() => undefined)
        return
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '创建分支失败'
        nyxusDraftActive.value = true
        return
      }
    }
    let targetChatId = chatId.value ?? undefined
    if (quickTargetRequired.value) {
      if (quickTarget.value?.target === 'new') {
        if (!presetName.value) {
          error.value = '当前 Pet 没有关联预设'
          return
        }
        try {
          targetChatId = await agents.createMasterPet({ preset: presetName.value })
          // 'new' 一次性消费：会话已创建即清空，防残留导致下次发送再建（AgentDialog 同约定，
          // 见 docs/interaction.md chat.route.suggest）。当前 quickTarget 无 UI 写入口，纯防御。
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
    if (targetChatId) {
      agents.activatePresetSession(quickPresetId.value, targetChatId, presetName.value)
      agents.setWorkbenchWindowChat(props.windowId, targetChatId)
    }
    await handleSend(targetChatId, { keepOpen: true })
    if (text.value) nyxusDraftActive.value = true
  }
  /** 查看 Nyxus 会话完整对话历史：打开根历史抽屉（与 PetStage 同款；panel 挂载自动 loadHistory）。 */
  function openHistory(): void {
    const id =
      taskTimeline.value?.branches?.find((branch) => branch.kind === 'original')?.chatId ??
      chatId.value
    if (!id) return
    agents.historyDrawerTaskBranches = taskTimeline.value?.branches ?? []
    agents.openHistoryRoot(id, 'workbench-docked', workbenchDrawerAnchor())
  }
  const {
    connection,
    createSession,
    creating,
    deleteNyxusSession,
    deletePresetSession,
    locateInteraction,
    onTreeInteractionFocus,
    releaseCurrentRoot,
    switchSession,
    treeFocusedInteraction,
    treeFocusInteractionId,
    treeFocusSourceChatId,
    treeLoading,
    treeRootChatId,
  } = useWorkbenchTreeSession({
    windowId: props.windowId,
    presetId: props.presetId,
    presetName,
    isNyxus,
    chatId,
    taskTimeline,
    drawerAnchor: workbenchDrawerAnchor,
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
  /** 无 root 时继续展示工作台既有的「新建会话」入口；创建后自动进入 Lite。 */
  const liteViewVisible = computed(() => liteViewEnabled.value && !!treeRootChatId.value)
  function closeWorkbench(): void {
    // 关闭工作台即关闭其 docked 历史抽屉：HistoryDrawer 读全局单例，不清理则抽屉及遮罩残留页面
    // （见 docs/web/workbench-multi-window.md「关闭工作台清理 docked 抽屉」）。overlay 全局抽屉保留。
    if (agents.historyDrawerMode === 'workbench-docked') agents.closeAllHistory()
    resetMedia()
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
    agents.setWorkbenchWindowMinimized(props.windowId, true)
    // 后缩的胶囊盖前缩的：把本窗提升到 z 序末尾，胶囊层叠时处于最上层。
    agents.focusWorkbenchWindow(props.windowId)
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
    if (nyxusDraftActive.value && e.key === 'Escape') {
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
  })
  onBeforeUnmount(() => {
    workbenchResizeObserver?.disconnect()
    if (typeof window !== 'undefined') {
    }
    if (sessionListCloseTimer) clearTimeout(sessionListCloseTimer)
    if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
    if (foldCloseTimer) clearTimeout(foldCloseTimer)
    window.removeEventListener('pointerdown', onRoleOutsidePointerDown)
    window.removeEventListener('pointerdown', onSessionOutsidePointerDown)
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

  return {
    AgentComposer,
    AnimatePresence,
    ConnectionStatusChip,
    ContextUsageBar,
    FOLD_ICONS,
    FOLD_TIPS,
    LiteView,
    MessageBranchTree,
    MotionDiv,
    NYXUS_WORKBENCH_Z_INDEX,
    NyxusPianoStrip,
    NyxusSessionList,
    OVERLAY_Z_INDEX,
    PendingOperationsPanel,
    PromptSnapshotTip,
    RoleConfigPopover,
    activateNyxusInput,
    activeCommandIndex,
    activeCommandTab,
    activeRoleIndex,
    agents,
    brains,
    branchTarget,
    branchTreeRef,
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
    createSession,
    creating,
    deleteNyxusSession,
    deletePresetSession,
    detailBranchAvailability,
    editorRefFn,
    effectiveMode,
    error,
    executeSessionControl,
    fmtTokens,
    foldMode,
    foldToolOpen,
    isNative,
    isNyxus,
    liteViewEnabled,
    liteViewVisible,
    loading,
    locateInteraction,
    matchingRoleMentions,
    maxControlState,
    mediaAttachments,
    mediaHint,
    mediaServicesByType,
    minimizeWorkbench,
    nyxusDraftActive,
    onDialogEditorKeydown,
    onEditorInput,
    onEditorPaste,
    onEditorSelectionChange,
    onMaximizeClick,
    onMediaSelected,
    closePiano,
    closeSessionList,
    onEasterEgg,
    onSessionDelete,
    onTitlePointerDown,
    onTreeInteractionFocus,
    onTreeEpochChange,
    onTreePromptSnapShow,
    openHistory,
    orderedRoleSelections,
    paperMode,
    pauseWholeTask,
    pianoOpen,
    presetName,
    primaryRole,
    primarySelection,
    quickPresetId,
    ref,
    removeMedia,
    resizeDirections,
    roleListOpen,
    roleListPinned,
    rootSessions,
    sessionListLoading,
    sessionListOpen,
    roleMenuRefFn,
    roleSelections,
    roleUsages,
    scheduleFoldToolClose,
    scheduleSessionListClose,
    scheduleRoleListClose,
    selectBranchTarget,
    selectCommand,
    selectCommandTab,
    selectFoldMode,
    selectRoleMention,
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
    showSessionList,
    showRoleList,
    showRoleMenu,
    supportsTools,
    switchSession,
    taskControlPending,
    taskHasRunningBranches,
    taskTimeline,
    text,
    toggleLiteView,
    toggleRoleList,
    toggleSessionList,
    topologyLayout,
    treeBreakdown,
    treeFocusInteractionId,
    treeFocusSourceChatId,
    treeFocusedInteraction,
    treeLoading,
    treePromptSnap,
    treeRootChatId,
    treeUsage,
    treeUsagePct,
    uploading,
    usageClass,
    win,
    windowBlink,
    workbenchShellRef,
    workbenchShellStyle,
    workbenchWindow,
  }
}
