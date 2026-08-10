<script setup lang="ts">
/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体预览下沉 MediaPreviewBar。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElPopover, ElTooltip } from 'element-plus'
import RoleConfigPopover from '../dialog/RoleConfigPopover.vue'
import AgentComposer from '../dialog/AgentComposer.vue'
import ConversationTargetPicker from '../dialog/ConversationTargetPicker.vue'
import WorkspaceSessionBrowser from '../dialog/WorkspaceSessionBrowser.vue'
import ContextBreakdownTip from '../toolbar/ContextBreakdownTip.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import { useAgentDialogOptions } from '../dialog/useAgentDialogOptions'
import {
  useWorkbenchWindow,
  type ResizeDirection,
} from '../dialog/useWorkbenchWindow'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'
import MessageBranchTree from '@/features/pets/nyxus/components/MessageBranchTree.vue'
import NyxusPianoStrip from '@/features/pets/nyxus/components/NyxusPianoStrip.vue'
import {
  terminalActionMode,
  type TerminalActionMode,
} from '@/features/pets/nyxus/composables/nodeInteraction'
import { selectCanResume } from '@/stores/chats/selectors'
import { NYXUS_WORKBENCH_Z_INDEX, OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const emptyNyxusDialog = ref(false)
// 共用单蒙层：仅当 AgentDialog 是栈顶 overlay 时其蒙层带 blur，否则透明（避免多层 blur 叠加）
const isTopMask = computed(() => agents.topOverlay === 'agentDialog' || emptyNyxusDialog.value)

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
  close: closeAgentDialog,
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
} = useAgentDialogOptions()

/** Cherry Nyxus 会话：节点树铺满工作台，历史钢琴与角色卡从右侧 dock 按需展开。 */
const dialogVisible = computed(() => !!chatId.value || emptyNyxusDialog.value)
const isNyxus = computed(() => emptyNyxusDialog.value || presetName.value === CHERY_NYXUS_PRESET)
interface QuickTargetSelection {
  target: string | 'new'
  source: 'ai' | 'user'
  confidence?: number
}
const quickTarget = ref<QuickTargetSelection>()
const quickRoutingPending = ref(false)
const quickRoutingWaiters: Array<() => void> = []
function setQuickRoutingPending(pending: boolean): void {
  quickRoutingPending.value = pending
  if (!pending) quickRoutingWaiters.splice(0).forEach((resolve) => resolve())
}
function clearAiQuickTarget(): void {
  if (quickTarget.value?.source === 'ai') quickTarget.value = undefined
}
function enableAiQuickTarget(): void {
  quickTarget.value = undefined
  error.value = null
}
async function waitForQuickRouting(): Promise<void> {
  if (!quickRoutingPending.value) return
  await new Promise<void>((resolve) => quickRoutingWaiters.push(resolve))
}
const dialogView = computed({
  get: () => agents.activeDialogView,
  set: (view: 'composer' | 'attention' | 'tree') => {
    agents.activeDialogView = view
  },
})
const isWorkbench = computed(() => isNyxus.value || dialogView.value === 'tree')
const workbenchWindow = useWorkbenchWindow()
const {
  shellRef: workbenchShellRef,
  mode: workbenchMode,
  position: workbenchPosition,
  size: workbenchSize,
  shellStyle: workbenchShellStyle,
} = workbenchWindow
const resizeDirections: ResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']
const WORKBENCH_RAIL_RESERVE = 148
/** 节点树实例 ref：最大化/窗口切换时显式触发复位，确保画布按新视口重排（RO 对瞬时全屏切换并不可靠）。 */
const branchTreeRef = ref<{ resetLayout: () => void } | null>(null)
function workbenchDrawerAnchor() {
  const rect = workbenchShellRef.value?.getBoundingClientRect()
  if (!rect) return null
  return {
    top: rect.top,
    left: rect.left,
    width: Math.max(0, rect.width - WORKBENCH_RAIL_RESERVE),
    height: rect.height,
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
const quickTargetRequired = computed(
  () => agents.activeDialogSource === 'pet' && !isNyxus.value && !!presetName.value,
)
const quickPresetId = computed(() => {
  if (pet.value?.presetId) return pet.value.presetId
  const summary = chatId.value
    ? agents.historyList.find((item) => item.chatId === chatId.value)
    : undefined
  return summary?.presetId
})
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
        (b.lastUserActivityAt ?? b.createdAt ?? 0) -
        (a.lastUserActivityAt ?? a.createdAt ?? 0),
    ),
)
const workspaceChats = computed(() =>
  (agents.historyList ?? []).filter((item) =>
    quickPresetId.value
      ? item.presetId === quickPresetId.value
      : !!presetName.value && item.preset === presetName.value,
  ),
)
const workspaceAttentionCount = computed(() =>
  workspaceChats.value.reduce(
    (count, item) => count + (item.pendingApproval ? 1 : 0) + (item.pendingQuestionCount ?? 0),
    0,
  ),
)
const quickRoutingEnabled = computed(() => {
  const preset = presetName.value ? config.value?.presets?.[presetName.value] : undefined
  return !!preset?.routingBrain
})
watch(dialogVisible, (open) => {
  if (open) {
    workbenchWindow.resetForOpen()
    if (agents.activeDialogSource === 'pet') quickTarget.value = undefined
  }
  if (!open) {
    agents.workbenchMinimized = false
    const observedRoot = treeRootChatId.value
    if (observedRoot) {
      if (isWorkbench.value) void chatSessions.closeRootTimeline(observedRoot)
      else void chatSessions.closeSession(observedRoot)
    }
    agents.closeAllHistory()
    quickTarget.value = undefined
    setQuickRoutingPending(false)
  }
})
const nyxusDraftActive = ref(false)
type FoldMode = 'none' | 'partial' | 'full'
const foldMode = ref<FoldMode>('partial')
/** 折叠三档控件：hover 时按钮自身变宽，左侧滑出 3 个子按钮，点击切换档位。 */
const foldToolOpen = ref(false)
const FOLD_GLYPHS: Record<FoldMode, string> = { none: '☷', partial: '▤', full: '▦' }
const FOLD_LABELS: Record<FoldMode, string> = {
  none: '不折叠',
  partial: '部分折叠',
  full: '全折叠',
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
const workspaceBrowserMode = ref<'attention'>()
/** 删除交互期间锁定 popout：hover 可删键 / 拖拽 / 倒掉动画时为 true，跳过延迟关闭。 */
const pianoPinned = ref(false)
let pianoCloseTimer: ReturnType<typeof setTimeout> | undefined
let pianoCloseRequested = false
const roleListOpen = ref(false)
/** 角色列表配置交互期间锁定：点击内部控件（select 等）时置位，防 hover 误关。 */
const roleListPinned = ref(false)
let roleListCloseTimer: ReturnType<typeof setTimeout> | undefined
// AgentComposer 的 3 个 DOM ref 桥接回 useAgentDialogOptions（selectCommand / commandMenuStyle 等依赖）。
const editorRefFn = (el: HTMLElement | null) => {
  editorRef.value = el
}
const commandMenuRefFn = (el: HTMLElement | null) => {
  commandMenuRef.value = el
}
const roleMenuRefFn = (el: HTMLElement | null) => {
  roleMenuRef.value = el
}
function showPiano(): void {
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  pianoCloseTimer = undefined
  pianoCloseRequested = false
  // 与角色列表互斥：展开钢琴时收起角色列表。
  closeRoleList()
  agents.closeAllHistory()
  workspaceBrowserMode.value = undefined
  pianoOpen.value = true
}
function schedulePianoClose(): void {
  if (pianoPinned.value) {
    pianoCloseRequested = true
    return
  }
  pianoCloseRequested = false
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  pianoCloseTimer = setTimeout(() => {
    pianoOpen.value = false
    pianoCloseTimer = undefined
  }, 160)
}
function onPianoInteracting(v: boolean): void {
  pianoPinned.value = v
  if (v) {
    showPiano()
    return
  }
  if (pianoCloseRequested) schedulePianoClose()
}
// ── 角色列表（参照钢琴 popout：hover/click 展开、延迟关闭、交互期间锁定） ──
function showRoleList(): void {
  if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
  roleListCloseTimer = undefined
  // 与钢琴互斥：展开角色列表时收起钢琴。
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  pianoCloseTimer = undefined
  pianoOpen.value = false
  agents.closeAllHistory()
  workspaceBrowserMode.value = undefined
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
function toggleWorkspaceBrowser(mode: 'attention'): void {
  closeRoleList()
  pianoOpen.value = false
  agents.closeAllHistory()
  workspaceBrowserMode.value = workspaceBrowserMode.value === mode ? undefined : mode
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
function activateNyxusInput(): void {
  nyxusDraftActive.value = true
  void nextTick(() => editorRef.value?.focus())
}
function cancelNyxusInput(): void {
  if (sending.value) return
  nyxusDraftActive.value = false
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
  if (isWorkbench.value) nyxusDraftActive.value = false
  let targetChatId = chatId.value ?? undefined
  if (quickTargetRequired.value) {
    if (quickTarget.value?.target === 'new') {
      if (!presetName.value) {
        error.value = '当前 Pet 没有关联预设'
        return
      }
      try {
        targetChatId = await agents.createMasterPet({ preset: presetName.value })
        await agents.fetchHistoryList()
      } catch (cause) {
        console.error('[AgentDialog] create target session failed:', cause)
        error.value = '新建会话失败，请重试或选择一个历史会话'
        return
      }
    } else {
      targetChatId = quickTarget.value?.target
    }
  }
  if (targetChatId) {
    agents.activatePresetSession(quickPresetId.value, targetChatId, presetName.value)
    agents.activeDialogChatId = targetChatId
  }
  await handleSend(targetChatId, { keepOpen: isWorkbench.value })
  if (isWorkbench.value && text.value) nyxusDraftActive.value = true
}
async function selectQuickTarget(selection: QuickTargetSelection): Promise<void> {
  if (quickTarget.value?.source === 'user' && selection.source === 'ai') return
  quickTarget.value = selection
  if (selection.target === 'new') return
  agents.activatePresetSession(quickPresetId.value, selection.target, presetName.value)
  agents.activeDialogChatId = selection.target
  await chatSessions.openSession(selection.target).catch((cause) =>
    console.warn('[AgentDialog] open explicitly selected target failed:', cause),
  )
}
/** 查看 Nyxus 会话完整对话历史：打开根历史抽屉（与 PetStage 同款；panel 挂载自动 loadHistory）。 */
function openHistory(): void {
  const id = chatId.value
  if (!id) return
  agents.openHistoryRoot(
    id,
    isWorkbench.value ? 'workbench-docked' : 'overlay',
    isWorkbench.value ? workbenchDrawerAnchor() : null,
  )
}
/**
 * 会话控制（停止/继续运行）：原挂 MessageBranchTree 终点节点，现移至弹窗 header 刷新按钮边。
 * running 显停止、canResume 且无未完成直接子会话显继续运行；逻辑参考 pet resume/abort。
 */
const sessionControlPending = ref(false)
const sessionControl = computed<{ mode: TerminalActionMode; label: string } | undefined>(() => {
  const id = chatId.value
  if (!id) return undefined
  const session = chatSessions.sessionsById[id]
  if (!session) return undefined
  const hasUnfinishedDirectChild = Object.values(chatSessions.sessionsById).some(
    (candidate) => candidate.meta.parentChatId === id && candidate.meta.finished !== true,
  )
  const mode = terminalActionMode(
    session.run.status === 'running',
    selectCanResume(session),
    hasUnfinishedDirectChild,
  )
  return mode ? { mode, label: mode === 'stop' ? '停止' : '继续运行' } : undefined
})
async function executeSessionControl(): Promise<void> {
  const mode = sessionControl.value?.mode
  const id = chatId.value
  if (!mode || !id || sessionControlPending.value) return
  sessionControlPending.value = true
  try {
    if (mode === 'stop') await chatSessions.abortAgent(id)
    else await chatSessions.resumeAgent(id)
  } catch (cause) {
    console.error(`[AgentDialog] ${mode} failed:`, cause)
  } finally {
    sessionControlPending.value = false
  }
}
/** 顶部树的独立根：琴键按下即同步更新，不等待对话框 options/hydration 的异步链。 */
const treeRootChatId = ref('')
const treeFocusSourceChatId = ref<string>()
const treeFocusInteractionId = ref<string>()
const showingTree = computed(() => isWorkbench.value)
watch(
  chatId,
  (id) => {
    if (id) {
      nyxusDraftActive.value = false
      treeRootChatId.value = id
    }
  },
  { immediate: true },
)
watch(
  [treeRootChatId, showingTree],
  ([rootChatId, treeVisible]) => {
    if (!rootChatId) return
    if (!treeVisible) {
      void chatSessions.closeRootTimeline(rootChatId)
      return
    }
    void chatSessions
      .observeRootTimeline(rootChatId, 'tree')
      .catch((cause) => console.error('[AgentDialog] observe root tree failed:', cause))
  },
  { immediate: true },
)
const creating = ref(false)

/** 钢琴键只切换观察中的 root。chat.close 仅取消旧订阅，后台 run 不受影响；
 * 新 root 通过原子 open + 完整 tree snapshot 恢复，不回放逐 chat token 事件。 */
async function switchSession(id: string): Promise<void> {
  if (!id) return
  const previousId = chatId.value
  agents.activeDialogSource = 'history'
  agents.activatePresetSession(quickPresetId.value, id, presetName.value)
  treeRootChatId.value = id
  if (id !== chatId.value) {
    if (isNyxus.value) agents.activeNyxusChatId = id
    agents.activeDialogChatId = id
  }
  try {
    if (showingTree.value) await chatSessions.observeRootTimeline(id, 'tree')
    else {
      if (previousId && previousId !== id) await chatSessions.closeSession(previousId)
      await chatSessions.openSession(id)
    }
    if (agents.historyDrawerStack.length > 0) {
      agents.openHistoryRoot(id, agents.historyDrawerMode, workbenchDrawerAnchor())
    }
  } catch (e) {
    console.error('[AgentDialog] switch session failed:', e)
  }
}

async function openWorkspaceTree(
  rootChatId: string,
  sourceChatId?: string,
  interactionId?: string,
): Promise<void> {
  workspaceBrowserMode.value = undefined
  treeFocusSourceChatId.value = sourceChatId
  treeFocusInteractionId.value = interactionId
  dialogView.value = 'tree'
  await switchSession(rootChatId)
}

function toggleCurrentTree(): void {
  if (dialogView.value === 'tree') {
    dialogView.value = 'composer'
    return
  }
  if (chatId.value) {
    agents.activeDialogSource = 'history'
    agents.activatePresetSession(quickPresetId.value, chatId.value, presetName.value)
  }
  dialogView.value = 'tree'
}

async function deletePresetSession(targetId: string): Promise<void> {
  if (!targetId) return
  if (targetId === chatId.value) {
    const remaining = quickSessions.value.find((session) => session.chatId !== targetId)
    if (remaining) await switchSession(remaining.chatId)
    else {
      error.value = '请先新建一个会话，再删除当前会话'
      return
    }
  }
  await agents.deleteSession(targetId)
}

/**
 * 加号「新建会话」：复用已有空白会话；无则新建。均跳转定位过去。
 * 刷新后 historyList 来自 listChats(false)(无 turnCount)；fetchHistoryList 取 listChats(true)
 * 才有 turnCount(0=空白，>0=有内容)，确保空白判定可靠。
 */
async function createSession(): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    await agents.fetchHistoryList()
    const blank = agents.historyList.find(
      (c) =>
        !c.parentChatId &&
        (quickPresetId.value ? c.presetId === quickPresetId.value : c.preset === presetName.value) &&
        (c.turnCount ?? 0) === 0,
    )
    const id = blank
      ? blank.chatId
      : isNyxus.value
        ? await agents.createNyxusSession()
        : await agents.createMasterPet({ preset: presetName.value })
    if (!blank) await agents.fetchHistoryList()
    await switchSession(id)
    emptyNyxusDialog.value = false
  } catch (e) {
    console.error('[AgentDialog] createSession failed:', e)
  } finally {
    creating.value = false
  }
}

/**
 * 钢琴键「删除会话」：先把焦点切到下一会话，再级联删除；本地 catalog 同步移除。
 * 删当前焦点会话时 deleteSession 内 removePetsAndStreams 会清 activeDialogChatId=null ->
 * overlay v-if 失败卸载再重挂载 = 整弹窗闪烁。故先切走焦点（同步设 id 在前），
 * 删除时 activeDialogChatId 已非被删项不触发 null 清理，弹窗仅数据响应式变化。
 * 删除唯一会话时保留 Nyxus 空态；弹窗不依赖待删 chatId，因而不会关闭或闪烁。
 */
async function deleteNyxusSession(targetId: string): Promise<void> {
  if (!targetId) return
  const wasFocus = targetId === chatId.value
  if (wasFocus) {
    const remaining = (agents.historyList ?? [])
      .filter((c) => !c.parentChatId && c.preset === CHERY_NYXUS_PRESET && c.chatId !== targetId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (remaining) {
      // switchSession 同步设 activeDialogChatId 在前、异步打开新 root；切走即生效。
      await switchSession(remaining.chatId)
    } else {
      // 空态保持弹窗可见；用户可通过标题栏“+”按需创建下一条会话。
      emptyNyxusDialog.value = true
      treeRootChatId.value = ''
    }
  }
  try {
    await agents.deleteSession(targetId)
  } catch (e) {
    console.error('[AgentDialog] deleteNyxusSession failed:', e)
    emptyNyxusDialog.value = false
    error.value = '删除会话失败'
    return
  }
}

function closeDialog(): void {
  const observedRoot = treeRootChatId.value
  const wasNyxus = isNyxus.value
  cancelNyxusInput()
  agents.workbenchMinimized = false
  emptyNyxusDialog.value = false
  agents.closeAllHistory()
  closeAgentDialog()
  agents.activeDialogSource = 'history'
  if (observedRoot) {
    if (wasNyxus || dialogView.value === 'tree') void chatSessions.closeRootTimeline(observedRoot)
    else void chatSessions.closeSession(observedRoot)
  }
}

function minimizeWorkbench(): void {
  if (!isWorkbench.value) return
  agents.workbenchMinimized = true
}

function restoreWorkbench(): void {
  if (!isWorkbench.value) return
  agents.workbenchMinimized = false
}

function onDialogEditorKeydown(e: KeyboardEvent): void {
  if (isWorkbench.value && nyxusDraftActive.value && e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelNyxusInput()
    return
  }
  if (emptyNyxusDialog.value && e.key === 'Escape') {
    e.preventDefault()
    closeDialog()
    return
  }
  onEditorKeydown(e, () => void sendFromComposer())
}

// ── 斜杠指令菜单定位（Teleport 到 body 后用 fixed 定位；锚定 .msg-input 顶部，向上展开） ──
const commandMenuStyle = reactive({
  zIndex: OVERLAY_Z_INDEX.composerMenu,
  bottom: '0px',
  left: '0px',
  width: '390px',
  maxHeight: '280px',
})
function positionCommandMenu(): void {
  const editor = editorRef.value
  const menu = commandMenuRef.value ?? roleMenuRef.value
  if (!editor || !menu) return
  const editorRect = editor.getBoundingClientRect()
  const margin = 8
  const minWidth = 280
  const maxWidth = Math.min(420, window.innerWidth - margin * 2)
  const width = Math.max(minWidth, Math.min(maxWidth, editorRect.width))
  const left = Math.max(margin, Math.min(editorRect.left, window.innerWidth - width - margin))
  // 菜单底边固定在输入框上沿 6px；内容/Tab 高度变化时只向上伸缩。
  commandMenuStyle.bottom = `${window.innerHeight - editorRect.top + 6}px`
  commandMenuStyle.left = `${left}px`
  commandMenuStyle.width = `${width}px`
  commandMenuStyle.maxHeight = `${Math.min(280, Math.max(0, editorRect.top - margin - 6))}px`
}
watch(showCommandMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(showRoleMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(activeCommandIndex, () => {
  // 高亮项滚动进视口后再校准菜单位置（菜单高度变化时）
  if (showCommandMenu.value) {
    nextTick(() => positionCommandMenu())
  }
})
watch([activeCommandTab, commandOptions], () => {
  if (showCommandMenu.value) nextTick(() => positionCommandMenu())
})
if (typeof window !== 'undefined') {
  window.addEventListener('resize', positionCommandMenu)
  window.addEventListener('scroll', positionCommandMenu, true)
}
onBeforeUnmount(() => {
  workbenchResizeObserver?.disconnect()
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', positionCommandMenu)
    window.removeEventListener('scroll', positionCommandMenu, true)
  }
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  if (roleListCloseTimer) clearTimeout(roleListCloseTimer)
  if (foldCloseTimer) clearTimeout(foldCloseTimer)
  window.removeEventListener('pointerdown', onRoleOutsidePointerDown)
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
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="dialogVisible"
      v-show="!agents.workbenchMinimized"
      key="overlay"
      class="dialog-overlay"
      :style="{
        zIndex: OVERLAY_Z_INDEX.composer,
        '--nx-z-canvas': NYXUS_WORKBENCH_Z_INDEX.canvas,
        '--nx-z-node-hit-target': NYXUS_WORKBENCH_Z_INDEX.nodeHitTarget,
        '--nx-z-node-overlay': NYXUS_WORKBENCH_Z_INDEX.nodeOverlay,
        '--nx-z-run-crt': NYXUS_WORKBENCH_Z_INDEX.runCrt,
        '--nx-z-composer': NYXUS_WORKBENCH_Z_INDEX.composer,
        '--nx-z-blocking-interaction': NYXUS_WORKBENCH_Z_INDEX.blockingInteraction,
        '--nx-z-chrome': NYXUS_WORKBENCH_Z_INDEX.chrome,
      }"
      :class="{
        'is-top-mask': isTopMask && !isWorkbench,
        'is-nyxus-layout': isWorkbench,
        'is-windowed-workbench': isWorkbench && workbenchMode === 'window',
      }"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <section
        v-if="isWorkbench"
        ref="workbenchShellRef"
        class="workbench-shell"
        :class="`is-${workbenchMode}`"
        :style="workbenchShellStyle"
        aria-label="节点树工作台"
      >
      <div class="nyxus-branch-top">
        <MessageBranchTree
          v-if="treeRootChatId"
          ref="branchTreeRef"
          :key="treeRootChatId"
          :root-chat-id="treeRootChatId"
          :fold-mode="foldMode"
          :focus-source-chat-id="treeFocusSourceChatId"
          :focus-interaction-id="treeFocusInteractionId"
          :full-render-threshold="agents.globalConfig?.global.tree_full_render_threshold"
        />
      </div>

      <header
        class="workbench-titlebar"
        :class="{ 'is-draggable': workbenchMode === 'window' }"
        @pointerdown="workbenchWindow.onTitlePointerDown"
      >
        <span class="workbench-title">{{ presetName || pet?.name || '节点树工作台' }}</span>
        <small>{{ workbenchMode === 'window' ? '拖动标题栏移动 · 拖动边缘缩放' : '节点树工作台' }}</small>
        <div class="workbench-window-actions" role="group" aria-label="窗口控制">
          <button
            type="button"
            class="window-control is-minimize"
            aria-label="最小化工作台"
            title="最小化"
            @click="minimizeWorkbench"
          >
            <span class="window-control-icon is-minimize" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="window-control is-maximize"
            :aria-label="workbenchMode === 'fullscreen' ? '还原窗口' : '最大化窗口'"
            :title="workbenchMode === 'fullscreen' ? '还原' : '最大化'"
            @click="workbenchWindow.toggleMode"
          >
            <span
              class="window-control-icon"
              :class="workbenchMode === 'fullscreen' ? 'is-restore' : 'is-maximize'"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="window-control is-close"
            aria-label="关闭节点树工作台"
            title="关闭"
            @click="closeDialog"
          >
            <span class="window-control-icon is-close" aria-hidden="true" />
          </button>
        </div>
      </header>

      <Transition name="nyxus-composer">
        <section
          v-if="nyxusDraftActive"
          id="nyxus-message-composer"
          class="nyxus-composer-dock"
          role="dialog"
          aria-modal="false"
          aria-label="发送新消息"
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
          @wheel.stop
        >
          <header class="nyxus-composer-head">
            <span class="nyxus-composer-status" aria-hidden="true" />
            <span class="nyxus-composer-title">
              <strong>发送新消息</strong>
              <small>发送后将作为新节点加入当前会话</small>
            </span>
            <button
              type="button"
              class="nyxus-composer-close"
              aria-label="放弃未发送消息"
              title="放弃草稿"
              :disabled="sending"
              @click="cancelNyxusInput"
            >
              ✕
            </button>
          </header>
          <div class="role-configs nyxus-role-configs">
            <div class="session-note">小组角色编制</div>
            <div
              v-if="loading"
              class="role-tags role-tags-skel"
              aria-busy="true"
              aria-label="角色编制加载中"
            >
              <span v-for="n in 3" :key="n" class="role-skel-tile" aria-hidden="true" />
            </div>
            <div v-else class="role-tags" aria-label="小组角色编制">
              <el-popover
                v-for="[role, selection] in orderedRoleSelections"
                :key="role"
                trigger="click"
                placement="bottom-start"
                :width="420"
                popper-class="role-runtime-popper"
              >
                <template #reference>
                  <button
                    type="button"
                    class="role-summary-tag"
                    :class="{ 'is-primary': role === primaryRole }"
                    :aria-label="`配置角色 ${role}，大脑 ${selection.brain || '未选择'}，${senseEntries(selection.senseGroup).length} 项能力`"
                  >
                    <span class="role-summary-main">
                      <span aria-hidden="true">{{ role === primaryRole ? '♛' : '✦' }}</span>
                      <span class="role-summary-name">{{ role }}</span>
                    </span>
                    <span class="role-summary-meta-row">
                      <span class="role-summary-model-slot">
                        <span class="role-summary-model">◈ {{ selection.brain || '—' }}</span>
                      </span>
                      <el-tooltip
                        v-if="roleUsages[role]"
                        placement="top"
                        :show-after="200"
                        :hide-after="0"
                      >
                        <template #content>
                          <span>上下文 {{ Math.round(roleUsages[role]!.usage * 100) }}%</span>
                        </template>
                        <span
                          class="role-usage-chip"
                          :class="usageClass(roleUsages[role]!.usage)"
                          :aria-label="`上下文 ${Math.round(roleUsages[role]!.usage * 100)}% · ${fmtTokens(roleUsages[role]!.used)} / ${fmtTokens(roleUsages[role]!.total)}`"
                          >{{ fmtTokens(roleUsages[role]!.used) }}/{{
                            fmtTokens(roleUsages[role]!.total)
                          }}</span
                        >
                      </el-tooltip>
                    </span>
                    <span
                      v-if="senseEntries(selection.senseGroup).length"
                      class="role-summary-senses"
                      aria-label="当前能力"
                    >
                      <span
                        v-for="entry in senseEntries(selection.senseGroup)"
                        :key="entry"
                        class="role-summary-sense-icon"
                      >
                        {{ senseTool(entry)?.icon ?? '⚙' }}
                      </span>
                    </span>
                  </button>
                </template>

                <RoleConfigPopover
                  :role="role"
                  :selection="selection"
                  :brains="brains"
                  :sense-groups="senseGroups"
                  :config="config"
                  :sense-tools="senseTools"
                  :is-primary="role === primaryRole"
                  :primary-role="primaryRole"
                  @update:selection="roleSelections[role] = $event"
                />
              </el-popover>
            </div>
          </div>
          <AgentComposer
            is-nyxus
            :nyxus-draft-active="nyxusDraftActive"
            :sending="sending"
            :loading="loading"
            :text="text"
            :error="error"
            :media-attachments="mediaAttachments"
            :media-hint="mediaHint"
            :uploading="uploading"
            :primary-selection="primarySelection"
            :supports-tools="supportsTools"
            :media-services-by-type="mediaServicesByType"
            :command-options="commandOptions"
            :command-tabs="commandTabs"
            :active-command-tab="activeCommandTab"
            :combo-command-groups="comboCommandGroups"
            :show-command-menu="showCommandMenu"
            :command-menu-style="commandMenuStyle"
            :active-command-index="activeCommandIndex"
            :show-role-menu="showRoleMenu"
            :matching-role-mentions="matchingRoleMentions"
            :active-role-index="activeRoleIndex"
            :editor-ref-fn="editorRefFn"
            :command-menu-ref-fn="commandMenuRefFn"
            :role-menu-ref-fn="roleMenuRefFn"
            @remove-media="removeMedia"
            @editor-input="onEditorInput"
            @editor-keydown="onDialogEditorKeydown"
            @editor-selection-change="onEditorSelectionChange"
            @editor-paste="onEditorPaste"
            @select-command="selectCommand"
            @select-command-tab="selectCommandTab"
            @select-role-mention="selectRoleMention"
            @media-selected="(f: any) => onMediaSelected(f)"
            @send="sendFromComposer"
            @update:active-command-index="activeCommandIndex = $event"
            @update:active-role-index="activeRoleIndex = $event"
          />
          <footer class="nyxus-composer-hint">
            <span><kbd>/</kbd> 指令 · <kbd>@</kbd> 角色</span>
            <span><kbd>Cmd/Ctrl</kbd> + <kbd>Enter</kbd> 发送</span>
          </footer>
        </section>
      </Transition>
      <nav class="nyxus-side-tools" aria-label="节点树工作台功能工具栏">
        <div class="nyxus-tool-column">
        <div class="nyxus-primary-tools" aria-label="主要操作">
          <button
            type="button"
            class="nyxus-rail-action is-message"
            :class="{ 'is-active': nyxusDraftActive }"
            :disabled="!chatId"
            :aria-label="nyxusDraftActive ? '继续编辑消息' : '发送消息'"
            :title="nyxusDraftActive ? '继续编辑' : '发送消息'"
            aria-controls="nyxus-message-composer"
            :aria-expanded="nyxusDraftActive"
            @click="activateNyxusInput"
          >
            <span aria-hidden="true">↗</span>
          </button>
          <button
            v-if="chatId && sessionControl"
            type="button"
            class="nyxus-rail-action"
            :class="`is-${sessionControl.mode}`"
            :disabled="sessionControlPending"
            :aria-label="sessionControl.mode === 'stop' ? '停止运行' : '继续运行'"
            :title="sessionControlPending ? '正在处理…' : sessionControl.mode === 'stop' ? '停止运行' : '继续运行'"
            @click="executeSessionControl"
          >
            <span aria-hidden="true">{{ sessionControl.mode === 'stop' ? '■' : '▶' }}</span>
          </button>
        </div>
        <div class="nyxus-tool-group" role="group" aria-label="会话工具">
          <button
            type="button"
            class="nyxus-rail-action"
            :disabled="!chatId"
            aria-label="对话历史"
            title="对话历史"
            @click="openHistory"
          >
            <span aria-hidden="true">◷</span>
          </button>
          <button
            type="button"
            class="nyxus-rail-action attention-rail-action"
            :class="{ 'is-active': workspaceBrowserMode === 'attention' }"
            aria-label="待处理交互"
            title="待处理交互"
            @click="toggleWorkspaceBrowser('attention')"
          >
            <span aria-hidden="true">!</span>
            <b v-if="workspaceAttentionCount">{{ workspaceAttentionCount }}</b>
          </button>
          <button
            type="button"
            class="nyxus-rail-action"
            :disabled="creating"
            aria-label="新建会话"
            title="新建会话"
            @click="createSession"
          >
            <span aria-hidden="true">＋</span>
          </button>
          <div class="nyxus-piano-tool" @pointerenter="showPiano" @focusin="showPiano" @pointerleave="schedulePianoClose">
            <button
              type="button"
              class="nyxus-rail-action"
              :class="{ 'is-active': pianoOpen }"
              aria-label="会话钢琴"
              title="会话钢琴"
              :aria-expanded="pianoOpen"
              @click="showPiano"
            >
              <span aria-hidden="true">▥</span>
            </button>
          </div>
        </div>
        <div class="nyxus-tool-group is-secondary" role="group" aria-label="视图与配置工具">
          <button
            v-if="!isNyxus"
            type="button"
            class="nyxus-rail-action"
            aria-label="返回快速发送窗口"
            title="返回快速发送窗口"
            @click="dialogView = 'composer'"
          >
            <span aria-hidden="true">↙</span>
          </button>
          <div
            class="nyxus-fold-tool"
            :class="{ 'is-open': foldToolOpen }"
            @pointerenter="showFoldTool"
            @focusin="showFoldTool"
            @pointerleave="scheduleFoldToolClose"
          >
            <button
              v-for="mode in (['none', 'partial', 'full'] as FoldMode[])"
              :key="mode"
              type="button"
              class="nyxus-fold-part"
              :class="{ 'is-selected': foldMode === mode }"
              :aria-label="FOLD_LABELS[mode]"
              :title="FOLD_LABELS[mode]"
              :aria-pressed="foldMode === mode"
              @click="selectFoldMode(mode)"
            >
              <span aria-hidden="true">{{ FOLD_GLYPHS[mode] }}</span>
            </button>
            <span class="nyxus-fold-current" aria-hidden="true">{{ FOLD_GLYPHS[foldMode] }}</span>
          </div>
          <div class="nyxus-role-tool" @pointerenter="showRoleList" @focusin="showRoleList" @pointerleave="scheduleRoleListClose">
            <button
              type="button"
              class="nyxus-rail-action"
              :class="{ 'is-active': roleListOpen }"
              aria-label="角色配置"
              title="角色配置"
              :aria-expanded="roleListOpen"
              @click="toggleRoleList"
            >
              <span aria-hidden="true">♟</span>
            </button>
          </div>
        </div>
        </div>
        <AnimatePresence>
          <MotionDiv
            v-if="workspaceBrowserMode"
            key="workspace-browser-popout"
            class="nyxus-workspace-browser-popout"
            :initial="{ opacity: 0, transform: 'translateX(18px) translateY(-50%) scale(0.96)' }"
            :animate="{ opacity: 1, transform: 'translateX(0) translateY(-50%) scale(1)' }"
            :exit="{ opacity: 0, transform: 'translateX(14px) translateY(-50%) scale(0.97)' }"
            :transition="{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }"
          >
            <WorkspaceSessionBrowser
              :sessions="workspaceChats"
              @tree="openWorkspaceTree"
            />
          </MotionDiv>
        </AnimatePresence>
        <AnimatePresence>
          <MotionDiv
            v-if="pianoOpen"
            key="piano-popout"
            class="nyxus-piano-popout"
            :initial="{ opacity: 0, transform: 'translateX(18px) scale(0.96)' }"
            :animate="{ opacity: 1, transform: 'translateX(0) scale(1)' }"
            :exit="{ opacity: 0, transform: 'translateX(14px) scale(0.97)' }"
            :transition="{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }"
            @pointerenter="showPiano()"
            @pointerleave="schedulePianoClose()"
          >
            <NyxusPianoStrip
              :preset-id="quickPresetId"
              :preset-name="presetName"
              :active-chat-id="chatId"
              @select="switchSession"
              @delete="isNyxus ? deleteNyxusSession($event) : deletePresetSession($event)"
              @interacting-change="onPianoInteracting"
            />
          </MotionDiv>
        </AnimatePresence>
        <AnimatePresence>
          <MotionDiv
            v-if="roleListOpen"
            key="role-popout"
            class="nyxus-role-popout"
            :initial="{ opacity: 0, transform: 'translateX(18px) translateY(-50%) scale(0.96)' }"
            :animate="{ opacity: 1, transform: 'translateX(0) translateY(-50%) scale(1)' }"
            :exit="{ opacity: 0, transform: 'translateX(14px) translateY(-50%) scale(0.97)' }"
            :transition="{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }"
            @pointerenter="showRoleList()"
            @pointerleave="scheduleRoleListClose()"
            @pointerdown="roleListPinned = true"
          >
            <div class="nyxus-role-card-list" aria-label="Nyxus 角色列表">
              <div v-if="loading" class="nyxus-role-loading">角色加载中…</div>
              <template v-else>
                <RoleConfigPopover
                  v-for="[role, selection] in orderedRoleSelections"
                  :key="role"
                  :role="role"
                  :selection="selection"
                  :brains="brains"
                  :sense-groups="senseGroups"
                  :config="config"
                  :sense-tools="senseTools"
                  :is-primary="role === primaryRole"
                  :primary-role="primaryRole"
                  @update:selection="roleSelections[role] = $event"
                />
              </template>
            </div>
          </MotionDiv>
        </AnimatePresence>
      </nav>
      <template v-if="workbenchMode === 'window'">
        <span
          v-for="direction in resizeDirections"
          :key="direction"
          class="workbench-resize-handle"
          :class="`is-${direction}`"
          :aria-label="`调整窗口大小 ${direction}`"
          @pointerdown="workbenchWindow.onResizePointerDown(direction, $event)"
        />
      </template>
      </section>
      <!-- 非 Nyxus：发消息弹窗 panel（header + 角色编制 + composer） -->
      <MotionDiv
        v-else
        key="panel"
        class="dialog-panel"
        :initial="{ opacity: 0, y: 16, scale: 0.96 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 12, scale: 0.97 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        :aria-label="`向 ${pet?.name ?? '智能体'} 发送消息`"
      >
        <header class="dialog-head">
          <span class="title">
            <span class="title-row">
              <el-tooltip
                v-if="pet?.workspace"
                placement="bottom"
                :show-after="200"
                :hide-after="0"
              >
                <template #content>
                  <span>工作区：{{ pet.workspace }}</span>
                  <span v-if="workspaceInvalid" style="color: #fca5a5"> · 路径失效</span>
                </template>
                <span class="who" :class="{ 'is-ws-invalid': workspaceInvalid }">
                  <span class="who-icon">{{ workspaceInvalid ? '⚠' : '📁' }}</span
                  >{{ pet?.name ?? 'agent' }}
                </span>
              </el-tooltip>
              <span v-else class="who">{{ pet?.name ?? 'agent' }}</span>
            </span>
            <span class="hint">Cmd/Ctrl+Enter 发送 · Esc 关闭</span>
          </span>
          <div class="head-actions">
            <button
              type="button"
              class="history-keys-btn"
              :class="{ 'is-active': dialogView === 'tree' }"
              aria-label="打开当前会话节点树工作台"
              title="打开节点树工作台"
              @click="toggleCurrentTree"
            >
              ⑂
            </button>
            <button
              type="button"
              class="history-keys-btn attention-head-btn"
              :class="{ 'is-active': dialogView === 'attention' }"
              aria-label="待处理交互"
              title="待处理交互"
              :aria-pressed="dialogView === 'attention'"
              @click="dialogView = dialogView === 'attention' ? 'composer' : 'attention'"
            >
              !<b v-if="workspaceAttentionCount">{{ workspaceAttentionCount }}</b>
            </button>
            <button type="button" class="close-btn" aria-label="关闭" @click="closeDialog">
              ✕
            </button>
          </div>
        </header>

        <WorkspaceSessionBrowser
          v-show="dialogView === 'attention'"
          :sessions="workspaceChats"
          @tree="openWorkspaceTree"
        />

        <div v-show="dialogView !== 'attention'" class="dialog-composer-content">
        <div class="role-configs">
          <div class="session-note">小组角色编制</div>
          <div
            v-if="loading"
            class="role-tags role-tags-skel"
            aria-busy="true"
            aria-label="角色编制加载中"
          >
            <span v-for="n in 3" :key="n" class="role-skel-tile" aria-hidden="true" />
          </div>
          <div v-else class="role-tags" aria-label="小组角色编制">
            <el-popover
              v-for="[role, selection] in orderedRoleSelections"
              :key="role"
              trigger="click"
              placement="bottom-start"
              :width="420"
              popper-class="role-runtime-popper"
            >
              <template #reference>
                <button
                  type="button"
                  class="role-summary-tag"
                  :class="{ 'is-primary': role === primaryRole }"
                  :aria-label="`配置角色 ${role}，大脑 ${selection.brain || '未选择'}，${senseEntries(selection.senseGroup).length} 项能力`"
                >
                  <span class="role-summary-main">
                    <span aria-hidden="true">{{ role === primaryRole ? '♛' : '✦' }}</span>
                    <span class="role-summary-name">{{ role }}</span>
                  </span>
                  <span class="role-summary-meta-row">
                    <span class="role-summary-model-slot">
                      <span class="role-summary-model">◈ {{ selection.brain || '—' }}</span>
                    </span>
                    <el-tooltip
                      v-if="roleUsages[role]"
                      placement="top"
                      :show-after="200"
                      :hide-after="0"
                    >
                      <template #content>
                        <ContextBreakdownTip
                          v-if="pet?.contextBreakdown"
                          :breakdown="pet.contextBreakdown"
                        />
                        <span v-else>上下文 {{ Math.round(roleUsages[role]!.usage * 100) }}%</span>
                      </template>
                      <span
                        class="role-usage-chip"
                        :class="usageClass(roleUsages[role]!.usage)"
                        :aria-label="`上下文 ${Math.round(roleUsages[role]!.usage * 100)}% · ${fmtTokens(roleUsages[role]!.used)} / ${fmtTokens(roleUsages[role]!.total)}`"
                        >{{ fmtTokens(roleUsages[role]!.used) }}/{{
                          fmtTokens(roleUsages[role]!.total)
                        }}</span
                      >
                    </el-tooltip>
                  </span>
                  <span
                    v-if="senseEntries(selection.senseGroup).length"
                    class="role-summary-senses"
                    aria-label="当前能力"
                  >
                    <span
                      v-for="entry in senseEntries(selection.senseGroup)"
                      :key="entry"
                      class="role-summary-sense-icon"
                    >
                      {{ senseTool(entry)?.icon ?? '⚙' }}
                    </span>
                  </span>
                </button>
              </template>

              <RoleConfigPopover
                :role="role"
                :selection="selection"
                :brains="brains"
                :sense-groups="senseGroups"
                :config="config"
                :sense-tools="senseTools"
                :is-primary="role === primaryRole"
                :primary-role="primaryRole"
                @update:selection="roleSelections[role] = $event"
              />
            </el-popover>
          </div>
        </div>

        <ConversationTargetPicker
          v-if="quickTargetRequired && quickPresetId"
          :preset-id="quickPresetId"
          :draft="text"
          :sessions="quickSessions"
          :selected="quickTarget?.target"
          :selected-source="quickTarget?.source"
          :routing-enabled="quickRoutingEnabled"
          @select="selectQuickTarget"
          @clear-ai="clearAiQuickTarget"
          @clear-target="quickTarget = undefined"
          @enable-auto="enableAiQuickTarget"
          @routing-change="setQuickRoutingPending"
        />

        <AgentComposer
          :is-nyxus="false"
          :nyxus-draft-active="nyxusDraftActive"
          :sending="sending"
          :loading="loading"
          :text="text"
          :error="error"
          :media-attachments="mediaAttachments"
          :media-hint="mediaHint"
          :uploading="uploading"
          :primary-selection="primarySelection"
          :supports-tools="supportsTools"
          :media-services-by-type="mediaServicesByType"
          :command-options="commandOptions"
          :command-tabs="commandTabs"
          :active-command-tab="activeCommandTab"
          :combo-command-groups="comboCommandGroups"
          :show-command-menu="showCommandMenu"
          :command-menu-style="commandMenuStyle"
          :active-command-index="activeCommandIndex"
          :show-role-menu="showRoleMenu"
          :matching-role-mentions="matchingRoleMentions"
          :active-role-index="activeRoleIndex"
          :editor-ref-fn="editorRefFn"
          :command-menu-ref-fn="commandMenuRefFn"
          :role-menu-ref-fn="roleMenuRefFn"
          :target-locked="!quickTargetRequired || (!!quickTarget && !quickRoutingPending)"
          @remove-media="removeMedia"
          @editor-input="onEditorInput"
          @editor-keydown="onDialogEditorKeydown"
          @editor-selection-change="onEditorSelectionChange"
          @editor-paste="onEditorPaste"
          @select-command="selectCommand"
          @select-command-tab="selectCommandTab"
          @select-role-mention="selectRoleMention"
          @media-selected="(f: any) => onMediaSelected(f)"
          @send="sendFromComposer"
          @update:active-command-index="activeCommandIndex = $event"
          @update:active-role-index="activeRoleIndex = $event"
        />
        </div>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
  <Teleport to="body">
    <Transition name="nyxus-min-tab">
      <div
        v-if="dialogVisible && isWorkbench && agents.workbenchMinimized"
        class="workbench-min-tab"
        role="button"
        tabindex="0"
        aria-label="还原节点树工作台"
        title="还原工作台"
        :style="{ zIndex: OVERLAY_Z_INDEX.composer }"
        @click="restoreWorkbench"
        @keydown.enter="restoreWorkbench"
        @keydown.space.prevent="restoreWorkbench"
      >
        <span class="workbench-min-tab-label">{{ presetName || pet?.name || '节点树工作台' }}</span>
        <button
          type="button"
          class="workbench-min-tab-close"
          aria-label="关闭节点树工作台"
          title="关闭"
          @click.stop="closeDialog"
        >
          <span class="workbench-min-tab-close-icon" aria-hidden="true" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="less">
@import '../dialog/agentDialog.less';

.role-usage-chip {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.history-keys-btn {
  width: 30px;
  height: 30px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  color: #50535b;
  cursor: pointer;
}
.history-keys-btn.is-active {
  border-color: #7c3aed;
  color: #6d28d9;
  background: rgba(124, 58, 237, 0.1);
}
.attention-head-btn {
  position: relative;
}
.attention-head-btn b {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 999px;
  background: #dc2626;
  color: #fff;
  font-size: 8px;
  line-height: 15px;
}
.role-summary-meta-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}
.role-usage-chip.usage-low {
  background: rgba(34, 197, 94, 0.14);
  color: #16a34a;
}
.role-usage-chip.usage-mid {
  background: rgba(234, 179, 8, 0.16);
  color: #a16207;
}
.role-usage-chip.usage-high {
  background: rgba(239, 68, 68, 0.16);
  color: #b91c1c;
}

.workbench-shell {
  position: absolute;
  overflow: hidden;
  color: #d9e7ea;
  background: #071018;
  isolation: isolate;
  pointer-events: auto;
}
.dialog-overlay.is-windowed-workbench {
  pointer-events: none;
}
.workbench-shell.is-fullscreen {
  inset: 0;
}
.workbench-shell.is-window {
  border: 0;
  border-radius: 4px;
  box-shadow: 0 24px 72px rgba(0, 0, 0, 0.4);
}
.workbench-titlebar {
  position: absolute;
  z-index: var(--nx-z-chrome);
  inset: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 150px 0 14px;
  color: rgba(222, 241, 244, 0.9);
  background: linear-gradient(180deg, rgba(13, 31, 41, 0.96), rgba(8, 22, 30, 0.84));
  border-bottom: 1px solid rgba(138, 211, 228, 0.14);
  cursor: default;
  user-select: none;
}
.workbench-titlebar.is-draggable {
  cursor: grab;
}
.workbench-titlebar.is-draggable:active {
  cursor: grabbing;
}
.workbench-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 750;
}
.workbench-titlebar small {
  color: rgba(177, 203, 209, 0.56);
  font-size: 9px;
}
.workbench-window-actions {
  position: absolute;
  inset: 0 0 auto auto;
  height: 40px;
  display: flex;
  align-items: stretch;
}
.window-control {
  position: relative;
  width: 46px;
  height: 40px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: rgba(222, 241, 244, 0.86);
  background: transparent;
  cursor: default;
  transition:
    color 100ms ease,
    background-color 100ms ease;
}
.window-control:hover,
.window-control:focus-visible {
  color: #fff;
  background: rgba(190, 216, 221, 0.14);
}
.window-control.is-close:hover,
.window-control.is-close:focus-visible {
  background: #c42b1c;
}
.window-control:focus-visible {
  outline: 1px solid rgba(181, 255, 242, 0.86);
  outline-offset: -2px;
}
.window-control-icon {
  position: relative;
  width: 11px;
  height: 11px;
}
.window-control-icon.is-minimize::before {
  content: '';
  position: absolute;
  right: 0;
  bottom: 2px;
  left: 0;
  border-top: 1px solid currentcolor;
}
.window-control-icon.is-maximize {
  border: 1px solid currentcolor;
}
.window-control-icon.is-restore::before,
.window-control-icon.is-restore::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  border: 1px solid currentcolor;
}
.window-control-icon.is-restore::before {
  top: 0;
  right: 0;
}
.window-control-icon.is-restore::after {
  bottom: 0;
  left: 0;
  background: #0d1f29;
}
.window-control-icon.is-close::before,
.window-control-icon.is-close::after {
  content: '';
  position: absolute;
  top: 5px;
  left: 0;
  width: 12px;
  border-top: 1px solid currentcolor;
}
.window-control-icon.is-close::before { transform: rotate(45deg); }
.window-control-icon.is-close::after { transform: rotate(-45deg); }
.workbench-shell.is-fullscreen .window-control-icon.is-restore::after {
  background: #071018;
}
.workbench-min-tab {
  position: fixed;
  left: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 6px 0 12px;
  border-radius: 6px;
  color: rgba(222, 241, 244, 0.9);
  background: #0d1f29;
  border: 1px solid rgba(138, 211, 228, 0.22);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  user-select: none;
}
.workbench-min-tab:hover {
  background: #122a36;
}
.workbench-min-tab:focus-visible {
  outline: 1px solid rgba(181, 255, 242, 0.86);
  outline-offset: 1px;
}
.workbench-min-tab-label {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 650;
}
.workbench-min-tab-close {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  color: rgba(222, 241, 244, 0.7);
  background: transparent;
  cursor: pointer;
}
.workbench-min-tab-close:hover,
.workbench-min-tab-close:focus-visible {
  color: #fff;
  background: #c42b1c;
}
.workbench-min-tab-close-icon {
  position: relative;
  width: 10px;
  height: 10px;
}
.workbench-min-tab-close-icon::before,
.workbench-min-tab-close-icon::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 0;
  width: 10px;
  border-top: 1px solid currentcolor;
}
.workbench-min-tab-close-icon::before { transform: rotate(45deg); }
.workbench-min-tab-close-icon::after { transform: rotate(-45deg); }
.nyxus-min-tab-enter-active,
.nyxus-min-tab-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}
.nyxus-min-tab-enter-from,
.nyxus-min-tab-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.workbench-resize-handle {
  position: absolute;
  z-index: calc(var(--nx-z-chrome) + 1);
}
.workbench-resize-handle.is-n,
.workbench-resize-handle.is-s {
  left: 10px;
  right: 10px;
  height: 8px;
  cursor: ns-resize;
}
.workbench-resize-handle.is-n { top: -3px; }
.workbench-resize-handle.is-s { bottom: -3px; }
.workbench-resize-handle.is-e,
.workbench-resize-handle.is-w {
  top: 10px;
  bottom: 10px;
  width: 8px;
  cursor: ew-resize;
}
.workbench-resize-handle.is-e { right: -3px; }
.workbench-resize-handle.is-w { left: -3px; }
.workbench-resize-handle.is-ne,
.workbench-resize-handle.is-se,
.workbench-resize-handle.is-sw,
.workbench-resize-handle.is-nw {
  width: 15px;
  height: 15px;
}
.workbench-resize-handle.is-ne { top: -4px; right: -4px; cursor: nesw-resize; }
.workbench-resize-handle.is-se { right: -4px; bottom: -4px; cursor: nwse-resize; }
.workbench-resize-handle.is-sw { bottom: -4px; left: -4px; cursor: nesw-resize; }
.workbench-resize-handle.is-nw { top: -4px; left: -4px; cursor: nwse-resize; }

.nyxus-page-close {
  position: absolute;
  z-index: var(--nx-z-chrome);
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 126, 148, 0.62);
  border-radius: 12px;
  background: rgba(25, 8, 16, 0.88);
  color: #ffd9e2;
  font-size: 16px;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease;
}
.nyxus-page-close:active {
  transform: scale(0.97);
}
.nyxus-side-tools {
  position: absolute;
  z-index: var(--nx-z-chrome);
  top: 50%;
  right: max(10px, env(safe-area-inset-right));
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  transform: translateY(-50%);
  pointer-events: none;
}
/* 内部滚动列承载高度限制；弹窗作为 nav 兄弟节点，避免被 overflow 裁剪。 */
.nyxus-tool-column {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 7px;
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.nyxus-primary-tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: auto;
}
.nyxus-rail-action {
  position: relative;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(138, 211, 228, 0.14);
  border-radius: 10px;
  color: rgba(202, 231, 237, 0.64);
  background: rgba(5, 18, 27, 0.5);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(9px) saturate(115%);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease;
}
.nyxus-rail-action.is-active {
  color: #eafffa;
  border-color: rgba(112, 225, 205, 0.24);
  background: rgba(67, 154, 139, 0.22);
}
.nyxus-rail-action.is-message {
  color: #c9fff3;
}
.nyxus-rail-action.is-stop {
  color: #ffc0cc;
}
.nyxus-rail-action.is-resume {
  color: #c8ffda;
}
/* 分组间用一条分割线切割，不做边框盒子；按钮与发送按钮同款 rail-action。 */
.nyxus-tool-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px solid rgba(145, 207, 219, 0.16);
  pointer-events: auto;
}
.nyxus-tool-group.is-secondary {
  border-top-color: rgba(145, 207, 219, 0.16);
  /* 折叠按钮变宽时会撑宽本组；右对齐让角色按钮等保持贴 rail 边缘，不随折叠按钮左移。 */
  align-items: flex-end;
}
.nyxus-piano-tool,
.nyxus-role-tool,
.nyxus-fold-tool {
  position: relative;
}
/* 折叠三档按钮：复用同一个外边框，hover 时水平变宽，左侧滑出 3 个子按钮，
   右侧保持当前档 icon。子按钮在流内，随容器一起把 rail 列撑宽，不触发裁剪。 */
.nyxus-fold-tool {
  position: relative;
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  align-items: center;
  gap: 2px;
  height: 30px;
  width: 30px;
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(138, 211, 228, 0.14);
  border-radius: 10px;
  color: rgba(202, 231, 237, 0.64);
  background: rgba(5, 18, 27, 0.5);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(9px) saturate(115%);
  pointer-events: auto;
  transition: width 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.nyxus-fold-tool.is-open {
  width: 128px;
}
.nyxus-fold-part,
.nyxus-fold-current {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  font-size: 12px;
  line-height: 1;
}
.nyxus-fold-part {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transform: translateX(-6px);
  transition:
    opacity 120ms ease,
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease;
}
.nyxus-fold-tool.is-open .nyxus-fold-part {
  opacity: 1;
  transform: translateX(0);
}
.nyxus-fold-part:hover,
.nyxus-fold-part.is-selected {
  color: #eafffa;
}
.nyxus-rail-action:active:not(:disabled) {
  transform: scale(0.97);
}
.nyxus-rail-action:disabled {
  cursor: not-allowed;
  opacity: 0.36;
}
.nyxus-rail-action:focus-visible,
.nyxus-page-close:focus-visible {
  outline: 2px solid #b5fff2;
  outline-offset: 2px;
}
.nyxus-piano-popout {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  width: min(680px, calc(100vw - 190px));
  height: 153px;
  margin-top: -76px;
  padding: 0 7px 7px;
  transform-origin: right center;
  pointer-events: auto;
  border: 1px solid rgba(255, 223, 157, 0.48);
  border-radius: 12px;
  background:
    linear-gradient(
      90deg,
      rgba(66, 36, 15, 0.97),
      rgba(132, 76, 25, 0.98) 50%,
      rgba(66, 36, 15, 0.97)
    ),
    #5f3312;
  box-shadow:
    0 18px 34px rgba(0, 0, 0, 0.42),
    inset 0 1px 0 rgba(255, 221, 151, 0.38);
}
.attention-rail-action b {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 999px;
  color: #fff;
  background: #dc2626;
  font-size: 8px;
  line-height: 15px;
}
.nyxus-workspace-browser-popout {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  width: min(620px, calc(100vw - 190px));
  max-height: min(72vh, 680px);
  overflow: hidden;
  pointer-events: auto;
  border: 1px solid rgba(138, 211, 228, 0.24);
  border-radius: 12px;
  color: #252932;
  background: rgba(251, 249, 244, 0.98);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.38);
  transform-origin: right center;
}
.nyxus-piano-popout :deep(.piano-keyboard) {
  position: relative;
  inset: auto;
  height: 146px;
  padding: 0;
}
.nyxus-piano-popout :deep(.piano-viewport) {
  height: 112px;
}
.nyxus-role-popout {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  width: min(440px, calc(100vw - 190px));
  padding: 0 7px 7px;
  transform-origin: right center;
  pointer-events: auto;
}
.nyxus-role-card-list {
  display: grid;
  gap: 10px;
  max-height: calc(100vh - 128px);
  overflow: auto;
  padding: 2px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 221, 151, 0.4) transparent;
}
.nyxus-role-card-list::-webkit-scrollbar {
  width: 6px;
}
.nyxus-role-card-list::-webkit-scrollbar-track {
  background: transparent;
}
.nyxus-role-card-list::-webkit-scrollbar-thumb {
  background: rgba(255, 221, 151, 0.4);
  border-radius: 3px;
}
.nyxus-role-card-list::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 221, 151, 0.6);
}
.nyxus-role-loading {
  padding: 18px;
  color: rgba(255, 255, 255, 0.72);
  text-align: center;
}

// 节点树不建立独立 stacking context；内部语义层可与 composer/工具栏正确比较。
// 画布从标题栏（40px）下方开始：fitToView 在「下方可视区」内居中/锚定，
// 复位/最大化后起始节点不再藏到标题栏下，画布真正用满可视区。
.nyxus-branch-top {
  position: absolute;
  inset: 40px 0 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.nyxus-branch-top :deep(.tree-viewport) {
  pointer-events: auto;
}

.nyxus-composer-dock {
  position: absolute;
  z-index: var(--nx-z-composer);
  right: max(62px, calc(env(safe-area-inset-right) + 52px));
  bottom: max(22px, env(safe-area-inset-bottom));
  left: max(22px, env(safe-area-inset-left));
  width: min(720px, calc(100vw - 106px));
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid rgba(116, 173, 184, 0.38);
  border-radius: 12px;
  color: #d9e7ea;
  background: rgba(8, 16, 22, 0.96);
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.48),
    0 0 0 1px rgba(87, 199, 212, 0.06);
  backdrop-filter: blur(14px);
  transform-origin: right bottom;
  pointer-events: auto;
}
.nyxus-composer-head {
  min-height: 46px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid rgba(150, 180, 190, 0.14);
  background: rgba(14, 25, 32, 0.82);
}
.nyxus-composer-status {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #69c995;
  box-shadow: 0 0 0 3px rgba(105, 201, 149, 0.1);
}
.nyxus-composer-title {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.nyxus-composer-title strong {
  color: #edf5f7;
  font-size: 12px;
  line-height: 1.2;
}
.nyxus-composer-title small {
  overflow: hidden;
  color: rgba(180, 199, 204, 0.66);
  font-size: 10px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nyxus-composer-close {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-left: auto;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  color: rgba(190, 207, 211, 0.72);
  background: transparent;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms ease,
    border-color 140ms ease,
    background-color 140ms ease;
}
.nyxus-composer-close:active:not(:disabled) {
  transform: scale(0.97);
}
.nyxus-composer-close:disabled {
  cursor: wait;
  opacity: 0.42;
}
.nyxus-composer-hint {
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px 8px;
  color: rgba(158, 181, 187, 0.58);
  font-size: 9px;
}
.nyxus-composer-hint kbd {
  padding: 1px 4px;
  border: 1px solid rgba(150, 180, 190, 0.18);
  border-radius: 4px;
  color: rgba(210, 225, 228, 0.78);
  background: rgba(150, 180, 190, 0.06);
  font: inherit;
}
// 节点树 composer 内置角色编制：与 composer 主体分隔，顶部留白让浅色 chip 不贴 dock 边缘。
.nyxus-role-configs {
  padding: 8px 14px 5px;
  border-bottom: 1px solid rgba(150, 180, 190, 0.14);
}
.nyxus-composer-enter-active,
.nyxus-composer-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
.nyxus-composer-leave-active {
  transition-duration: 140ms;
}
.nyxus-composer-enter-from,
.nyxus-composer-leave-to {
  opacity: 0;
  transform: translateX(18px) scale(0.98);
}
@media (hover: hover) and (pointer: fine) {
  .nyxus-page-close:hover:not(:active) {
    color: #fff;
    border-color: #ff718c;
    background: rgba(86, 18, 37, 0.92);
  }
  .nyxus-rail-action:hover:not(:active):not(:disabled) {
    color: #effffc;
    background: rgba(112, 225, 205, 0.11);
  }
  .nyxus-composer-close:hover:not(:disabled) {
    color: #edf5f7;
    border-color: rgba(87, 199, 212, 0.22);
    background: rgba(87, 199, 212, 0.07);
  }
}
@media (max-width: 720px) {
  .nyxus-side-tools {
    top: 50%;
    right: 8px;
  }
  .nyxus-piano-popout {
    right: -62px;
    top: auto;
    bottom: calc(100% + 10px);
    width: calc(100vw - 72px);
    margin-top: 0;
  }
  .nyxus-composer-dock {
    right: 52px;
    bottom: 12px;
    left: 12px;
    width: auto;
  }
  .nyxus-composer-title small,
  .nyxus-composer-hint span:first-child {
    display: none;
  }
}
@media (max-height: 520px) and (min-width: 721px) {
  .nyxus-side-tools {
    top: 50%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .nyxus-composer-enter-active,
  .nyxus-composer-leave-active {
    transition: opacity 150ms ease;
  }
  .nyxus-composer-enter-from,
  .nyxus-composer-leave-to {
    transform: none;
  }
  .nyxus-piano-popout {
    transform: none !important;
  }
  .nyxus-rail-action,
  .nyxus-page-close,
  .nyxus-composer-close {
    transform: none !important;
    transition-duration: 0ms, 120ms, 120ms, 120ms;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .nyxus-rail-action,
  .nyxus-composer-dock {
    background: #071822;
    backdrop-filter: none;
  }
}
@media (prefers-contrast: more) {
  .nyxus-rail-action,
  .nyxus-composer-dock {
    border-color: currentcolor;
  }
}

// 标题栏右簇（静音 + 关闭）。
.head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

// 标题栏图标钮（琴键音开关），与 close-btn 同尺寸。
.head-icon-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(180, 110, 20, 0.3);
  border-radius: 7px;
  background: rgba(255, 245, 230, 0.5);
  color: #76500e;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 100ms ease,
    border-color 100ms ease;
  &:hover {
    background: rgba(255, 233, 184, 0.7);
    border-color: rgba(246, 183, 60, 0.6);
  }
  &.is-active {
    color: #155e75;
    border-color: rgba(34, 211, 238, 0.62);
    background: rgba(165, 243, 252, 0.58);
  }
}
</style>

<!-- Popover 挂载到 Teleport 根节点，需用非 scoped 样式去除 Element Plus 的外层壳。 -->
<style lang="less">
.role-runtime-popper.el-popper {
  --el-popover-border-color: transparent;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.role-runtime-popper .el-popper__arrow {
  display: none;
}

.add-media-popper.el-popover {
  border-radius: 10px;
}

.add-media-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.add-media-upload {
  width: 100%;

  .el-upload {
    width: 100%;
    display: block;
  }
}

.add-media-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 550;
  color: #14161a;
  transition: background-color 100ms ease;

  &:hover {
    background: rgba(246, 183, 60, 0.12);
  }

  span:first-child {
    font-size: 14px;
  }
}

.media-svc-tag {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(246, 183, 60, 0.15);
  color: #9a7422;
  &.missing {
    background: rgba(180, 30, 30, 0.08);
    color: #b04040;
  }
}

// 指令卡片由富文本编辑器在 hover 时挂到 body，避免被输入框和弹窗滚动容器裁剪。
.instruction-token-floating-popover {
  position: fixed;
  z-index: 320;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 248px;
  padding: 8px 9px;
  border: 1px solid rgba(35, 38, 44, 0.14);
  border-radius: 7px;
  background: #fffdf8;
  box-shadow: 0 7px 18px rgba(20, 22, 26, 0.18);
  color: #14161a;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.45;
  pointer-events: none;
}

.instruction-token-floating-title {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 750;
}

.instruction-token-floating-description {
  color: rgba(20, 22, 26, 0.76);
}

.instruction-token-floating-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 5px;
  border-top: 1px solid rgba(35, 38, 44, 0.1);
  color: #8c6114;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
}
</style>
