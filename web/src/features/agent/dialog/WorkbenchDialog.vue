<script setup lang="ts">
/**
 * WorkbenchDialog：节点树工作台多窗口组件（C-3 抽取）。
 * 每窗口对应一个 preset，windowId = presetId。与 AgentDialog（快速发送 composer 单例）解耦：
 *   - chatId 来源 = store workbenchWindows[windowId].chatId（不再读全局 activeDialogChatId）
 *   - 视图/几何/最小化/会话写回 store 的 setWorkbenchWindow* per-window action
 *   - useAgentDialogOptions 传 per-window chatId；useWorkbenchWindow 传 windowId（per-window localStorage key）
 * 历史抽屉仍为全局单例（HistoryDrawer 单例渲染），openHistory/锚点写全局 agents.historyDrawer*。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElMessage, ElPopover, ElTooltip } from 'element-plus'
import RoleConfigPopover from './RoleConfigPopover.vue'
import AgentComposer from './AgentComposer.vue'
import WorkspaceSessionBrowser from './WorkspaceSessionBrowser.vue'
import ContextUsageBar from '../drawer/ContextUsageBar.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import PromptSnapshotTip from '../drawer/PromptSnapshotTip.vue'
import {
  agentApi,
  type ContextBreakdown,
  type PromptSnapshotTool,
} from '@/services/agentApi'
import { useAgentDialogOptions } from './useAgentDialogOptions'
import {
  useWorkbenchWindow,
  type ResizeDirection,
} from './useWorkbenchWindow'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { useChatSessionData } from '@/stores/chats/useChatSessionData'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'
import MessageBranchTree from '@/features/pets/nyxus/components/MessageBranchTree.vue'
import NyxusPianoStrip from '@/features/pets/nyxus/components/NyxusPianoStrip.vue'
import {
  terminalActionMode,
} from '@/features/pets/nyxus/composables/nodeInteraction'
import { selectCanResume } from '@/stores/chats/selectors'
import { NYXUS_WORKBENCH_Z_INDEX, OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

const props = defineProps<{ windowId: string; presetId: string }>()

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()

/** 本窗口状态（store 注册表按 windowId 索引）。窗口关闭/不存在时组件不渲染。 */
const win = computed(() => agents.workbenchWindows[props.windowId])

/** Phase E：需用户操作（审批/提问）时窗口闪烁。非聚焦窗由 store 置位，点击窗口熄灭。 */
const windowBlink = computed(() => win.value?.attentionBlink ?? false)

/** 点击标题栏即视为用户已注意到该窗口 → 熄灭闪烁。 */
function onTitlePointerDown(e: PointerEvent): void {
  agents.setWorkbenchWindowBlink(props.windowId, false)
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
} = useAgentDialogOptions({ chatId: () => win.value?.chatId ?? null })

const isNyxus = computed(() => presetName.value === CHERY_NYXUS_PRESET)

/** 抽屉/树的视图（per-window）：写回 store setWorkbenchWindowView。 */
const winView = computed({
  get: () => win.value?.view ?? 'tree',
  set: (view: 'composer' | 'attention' | 'tree') => {
    agents.setWorkbenchWindowView(props.windowId, view)
  },
})

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
  // 完全参考「待处理交互抽屉」：从标题栏（40px）下方起始、铺满内容区全宽，
  // 使历史抽屉盖住右侧 rail 按钮；标题栏窗口控制按钮（关闭/最大化/最小化）保持可用。
  const TITLEBAR_H = 40
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
const quickRoutingPending = ref(false)
const quickRoutingWaiters: Array<() => void> = []
function setQuickRoutingPending(pending: boolean): void {
  quickRoutingPending.value = pending
  if (!pending) quickRoutingWaiters.splice(0).forEach((resolve) => resolve())
}
async function waitForQuickRouting(): Promise<void> {
  if (!quickRoutingPending.value) return
  await new Promise<void>((resolve) => quickRoutingWaiters.push(resolve))
}
const quickPresetId = computed(() => props.presetId)
const quickTargetRequired = computed(
  () => agents.activeDialogSource === 'pet' && !isNyxus.value && !!presetName.value,
)
const quickSessions = computed(() =>
  (agents.historyList ?? [])
    .filter(
      (item) =>
        !item.parentChatId &&
        item.presetId === quickPresetId.value,
    )
    .sort(
      (a, b) =>
        (b.lastUserActivityAt ?? b.createdAt ?? 0) -
        (a.lastUserActivityAt ?? a.createdAt ?? 0),
    ),
)
const workspaceChats = computed(() =>
  (agents.historyList ?? []).filter((item) => item.presetId === quickPresetId.value),
)
const workspaceAttentionCount = computed(() =>
  workspaceChats.value.reduce(
    (count, item) => count + (item.pendingApproval ? 1 : 0) + (item.pendingQuestionCount ?? 0),
    0,
  ),
)

const nyxusDraftActive = ref(false)
type FoldMode = 'none' | 'partial' | 'full' | 'participant'
const foldMode = ref<FoldMode>('partial')
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
/** 抽屉为 modal：遮罩点击/✕/ESC 关闭，关闭前底层内容不可交互。 */
function onWorkspaceDrawerKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && workspaceBrowserMode.value) {
    e.preventDefault()
    toggleWorkspaceBrowser('attention')
  }
}
watch(workspaceBrowserMode, (open) => {
  if (open) window.addEventListener('keydown', onWorkspaceDrawerKeydown)
  else window.removeEventListener('keydown', onWorkspaceDrawerKeydown)
})
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
  nyxusDraftActive.value = false
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
  const id = chatId.value
  if (!id) return
  agents.openHistoryRoot(id, 'workbench-docked', workbenchDrawerAnchor())
}
/**
 * 会话控制（停止/继续运行）：原挂 MessageBranchTree 终点节点，现移至弹窗 header 刷新按钮边。
 * running 显停止、canResume 且无未完成直接子会话显继续运行；逻辑参考 pet resume/abort。
 */
const sessionControlPending = ref(false)
type WorkbenchControlMode = 'pause' | 'resume-tree' | 'resume-root'
const sessionControl = computed<{ mode: WorkbenchControlMode; label: string } | undefined>(() => {
  const id = chatId.value
  if (!id) return undefined
  const session = chatSessions.sessionsById[id]
  if (!session) return undefined
  const timeline = chatSessions.rootTimeline(id, 'tree')
  const treeRunning = timeline?.activeRuns.some(
    (run) => run.status === 'running' || run.status === 'waiting',
  )
  if (treeRunning || session.run.status === 'running') return { mode: 'pause', label: '暂停' }
  const control = timeline?.controlState
  const resumableTargets = control?.targets.filter(
    (target) => target.status === 'paused' || target.status === 'failed',
  )
  if (control && resumableTargets && resumableTargets.length > 0) {
    return { mode: 'resume-tree', label: '继续' }
  }
  const hasUnfinishedDirectChild = Object.values(chatSessions.sessionsById).some(
    (candidate) => candidate.meta.parentChatId === id && candidate.meta.finished !== true,
  )
  const mode = terminalActionMode(
    session.run.status === 'running',
    selectCanResume(session),
    hasUnfinishedDirectChild,
  )
  return mode === 'run' ? { mode: 'resume-root', label: '继续' } : undefined
})
async function executeSessionControl(): Promise<void> {
  const mode = sessionControl.value?.mode
  const id = chatId.value
  if (!mode || !id || sessionControlPending.value) return
  sessionControlPending.value = true
  try {
    if (mode === 'pause') await chatSessions.abortAgent(id)
    else if (mode === 'resume-tree') {
      const pauseId = chatSessions.rootTimeline(id, 'tree')?.controlState?.pauseId
      if (!pauseId) throw new Error('暂停状态已变化，请重试')
      await chatSessions.resumeTree(id, pauseId)
    } else await chatSessions.resumeAgent(id)
  } catch (cause) {
    console.error(`[WorkbenchDialog] ${mode} failed:`, cause)
    ElMessage.error(cause instanceof Error ? cause.message : '会话控制失败，请重试')
  } finally {
    sessionControlPending.value = false
  }
}
/** 顶部树的独立根：琴键按下即同步更新，不等待对话框 options/hydration 的异步链。 */
const treeRootChatId = ref('')
const treeFocusSourceChatId = ref<string>()
const treeFocusInteractionId = ref<string>()
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
// 树订阅：按窗口 chatId 观察根 timeline（多窗口各自独立订阅）。
watch(
  treeRootChatId,
  (rootChatId) => {
    if (!rootChatId) return
    void chatSessions
      .observeRootTimeline(rootChatId, 'tree')
      .catch((cause) => console.error('[WorkbenchDialog] observe root tree failed:', cause))
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
    agents.setWorkbenchWindowChat(props.windowId, id)
  }
  try {
    await chatSessions.observeRootTimeline(id, 'tree')
    if (agents.historyDrawerStack.length > 0) {
      agents.openHistoryRoot(id, agents.historyDrawerMode, workbenchDrawerAnchor())
    }
  } catch (e) {
    console.error('[WorkbenchDialog] switch session failed:', e)
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
  winView.value = 'tree'
  await switchSession(rootChatId)
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
        c.presetId === quickPresetId.value &&
        (c.turnCount ?? 0) === 0,
    )
    const id = blank
      ? blank.chatId
      : isNyxus.value
        ? await agents.createNyxusSession()
        : await agents.createMasterPet({ preset: presetName.value })
    if (!blank) await agents.fetchHistoryList()
    await switchSession(id)
  } catch (e) {
    console.error('[WorkbenchDialog] createSession failed:', e)
  } finally {
    creating.value = false
  }
}

/**
 * 钢琴键「删除会话」：先把焦点切到下一会话，再级联删除；本地 catalog 同步移除。
 * 删当前焦点会话时先切走焦点（setWorkbenchWindowChat 同步设 id 在前），避免弹窗数据响应式变化。
 */
async function deleteNyxusSession(targetId: string): Promise<void> {
  if (!targetId) return
  const wasFocus = targetId === chatId.value
  if (wasFocus) {
    const remaining = (agents.historyList ?? [])
      .filter((c) => !c.parentChatId && c.preset === CHERY_NYXUS_PRESET && c.chatId !== targetId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (remaining) {
      await switchSession(remaining.chatId)
    } else {
      treeRootChatId.value = ''
    }
  }
  try {
    await agents.deleteSession(targetId)
  } catch (e) {
    console.error('[WorkbenchDialog] deleteNyxusSession failed:', e)
    error.value = '删除会话失败'
    return
  }
}

function closeWorkbench(): void {
  const observedRoot = treeRootChatId.value
  resetMedia()
  error.value = null
  agents.closeAllHistory()
  agents.closeWorkbenchWindow(props.windowId)
  if (observedRoot) {
    void chatSessions.closeRootTimeline(observedRoot)
  }
}

function minimizeWorkbench(): void {
  agents.setWorkbenchWindowMinimized(props.windowId, true)
  // 后缩的胶囊盖前缩的：把本窗提升到 z 序末尾，胶囊层叠时处于最上层。
  agents.focusWorkbenchWindow(props.windowId)
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
  window.removeEventListener('keydown', onWorkspaceDrawerKeydown)
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

// ── 节点树工作台上下文占用 ──
// Nyxus 会话不建 PetInstance，不走 pet.contextUsage。session 的 context.contextUsage/contextBreakdown
// 仅在会话发生 stream.done 后水合（树模式 observeRootTimeline 走 rootTimelines，不水合 sessionsById），
// 故对刚加载的历史树可能为空 → 显式调 chat.contextUsage RPC 拉取权威快照兜底。
const rootSessionData = useChatSessionData(() => treeRootChatId.value || undefined)
const treeCtxUsage = ref<{ usage: number; breakdown: ContextBreakdown | null }>({
  usage: 0,
  breakdown: null,
})
let treeCtxUsageChatId = ''
async function loadTreeContextUsage(chatId: string): Promise<void> {
  if (treeCtxUsageChatId === chatId) return
  treeCtxUsageChatId = chatId
  try {
    const res = await agentApi.contextUsage(chatId)
    if (treeCtxUsageChatId === chatId) {
      treeCtxUsage.value = { usage: res.contextUsage, breakdown: res.contextBreakdown }
    }
  } catch {
    // 拉取失败保持当前值；session 水合后仍可实时补上
  }
}
watch(
  treeRootChatId,
  (id) => {
    if (id) void loadTreeContextUsage(id)
  },
  { immediate: true },
)
// 实时 session 数据优先；未水合（undefined/null）时退回 RPC 快照。
const treeUsage = computed(() => rootSessionData.contextUsage.value ?? treeCtxUsage.value.usage) // 0-1
const treeUsagePct = computed(() => Math.round(treeUsage.value * 100)) // 「看上下文」按钮 tooltip 用
const treeBreakdown = computed(
  () => rootSessionData.contextBreakdown.value ?? treeCtxUsage.value.breakdown,
)

/**
 * 系统提示词快照（「看上下文」按钮 hover 面板用）。
 * 懒加载：点击「看上下文」才拉取 chat.promptSnapshot；按 chatId 缓存避免重复请求。
 * treeRootChatId 切换（切根）时重拉。
 */
const treePromptSnap = ref<{
  systemPrompt: string
  tools: PromptSnapshotTool[]
  status: 'idle' | 'loading' | 'error' | 'loaded'
  error?: string
} | null>(null)
let treePromptSnapChatId = ''

async function loadTreePromptSnapshot(chatId: string): Promise<void> {
  if (treePromptSnapChatId === chatId && treePromptSnap.value && treePromptSnap.value.status !== 'error')
    return
  treePromptSnapChatId = chatId
  treePromptSnap.value = { systemPrompt: '', tools: [], status: 'loading' }
  try {
    const res = await agentApi.promptSnapshot(chatId)
    if (treePromptSnapChatId === chatId) {
      treePromptSnap.value = { systemPrompt: res.systemPrompt, tools: res.tools, status: 'loaded' }
    }
  } catch (err) {
    if (treePromptSnapChatId === chatId) {
      treePromptSnap.value = {
        systemPrompt: '',
        tools: [],
        status: 'error',
        error: (err as Error).message,
      }
    }
  }
}

function onTreePromptSnapShow(): void {
  if (!treeRootChatId.value) return
  void loadTreePromptSnapshot(treeRootChatId.value)
}
</script>

<template>
  <MotionDiv
    v-if="win"
    v-show="!win.minimized"
    class="dialog-overlay is-nyxus-layout"
    :class="{ 'is-windowed-workbench': workbenchMode === 'window' }"
    :style="{
      zIndex: OVERLAY_Z_INDEX.composer + (win.zOrder ?? 0),
      '--nx-z-canvas': NYXUS_WORKBENCH_Z_INDEX.canvas,
      '--nx-z-node-hit-target': NYXUS_WORKBENCH_Z_INDEX.nodeHitTarget,
      '--nx-z-node-overlay': NYXUS_WORKBENCH_Z_INDEX.nodeOverlay,
      '--nx-z-run-crt': NYXUS_WORKBENCH_Z_INDEX.runCrt,
      '--nx-z-composer': NYXUS_WORKBENCH_Z_INDEX.composer,
      '--nx-z-blocking-interaction': NYXUS_WORKBENCH_Z_INDEX.blockingInteraction,
      '--nx-z-chrome': NYXUS_WORKBENCH_Z_INDEX.chrome,
      '--nx-z-drawer-mask': NYXUS_WORKBENCH_Z_INDEX.drawerMask,
      '--nx-z-drawer': NYXUS_WORKBENCH_Z_INDEX.drawer,
    }"
    :initial="{ opacity: 0 }"
    :animate="{ opacity: 1 }"
    :transition="{ duration: 0.16 }"
  >
    <section
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
        :class="{ 'is-draggable': workbenchMode === 'window', 'has-attention': windowBlink }"
        @pointerdown="onTitlePointerDown"
      >
        <span class="workbench-title">{{ presetName || '节点树工作台' }}</span>
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
            @click="closeWorkbench"
          >
            <span class="window-control-icon is-close" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div v-if="treeRootChatId" class="workbench-ctx-bar">
        <ContextUsageBar
          :usage="treeUsage"
          :breakdown="treeBreakdown"
          variant="divider"
        />
      </div>

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
          <el-tooltip
            :content="nyxusDraftActive ? '继续编辑消息' : '发送消息'"
            placement="left"
            :show-after="200"
            :hide-after="0"
          >
            <span class="nyxus-tool-tip-anchor">
              <button
                type="button"
                class="nyxus-rail-action is-message"
                :class="{ 'is-active': nyxusDraftActive }"
                :disabled="!chatId"
                :aria-label="nyxusDraftActive ? '继续编辑消息' : '发送消息'"
                aria-controls="nyxus-message-composer"
                :aria-expanded="nyxusDraftActive"
                @click="activateNyxusInput"
              >
                <span aria-hidden="true">↗</span>
              </button>
            </span>
          </el-tooltip>
          <el-tooltip
            v-if="chatId && sessionControl"
            :content="sessionControlPending ? '正在处理…' : sessionControl.mode === 'pause' ? '暂停任务树' : '继续任务树'"
            placement="left"
            :show-after="200"
            :hide-after="0"
          >
            <span class="nyxus-tool-tip-anchor">
              <button
                type="button"
                class="nyxus-rail-action"
                :class="sessionControl.mode === 'pause' ? 'is-stop' : 'is-run'"
                :disabled="sessionControlPending"
                :aria-label="sessionControl.mode === 'pause' ? '暂停任务树' : '继续任务树'"
                @click="executeSessionControl"
              >
                <span aria-hidden="true">{{ sessionControl.mode === 'pause' ? '■' : '▶' }}</span>
              </button>
            </span>
          </el-tooltip>
        </div>
        <div class="nyxus-tool-group" role="group" aria-label="会话工具">
          <el-tooltip
            content="对话历史"
            placement="left"
            :show-after="200"
            :hide-after="0"
          >
            <span class="nyxus-tool-tip-anchor">
              <button
                type="button"
                class="nyxus-rail-action"
                :disabled="!chatId"
                aria-label="对话历史"
                @click="openHistory"
              >
                <span aria-hidden="true">◷</span>
              </button>
            </span>
          </el-tooltip>
          <el-tooltip
            content="待处理交互"
            placement="left"
            :show-after="200"
            :hide-after="0"
          >
            <span class="nyxus-tool-tip-anchor">
              <button
                type="button"
                class="nyxus-rail-action attention-rail-action"
                :class="{ 'is-active': workspaceBrowserMode === 'attention' }"
                aria-label="待处理交互"
                @click="toggleWorkspaceBrowser('attention')"
              >
                <span aria-hidden="true">!</span>
                <b v-if="workspaceAttentionCount">{{ workspaceAttentionCount }}</b>
              </button>
            </span>
          </el-tooltip>
          <el-tooltip
            content="新建会话"
            placement="left"
            :show-after="200"
            :hide-after="0"
          >
            <span class="nyxus-tool-tip-anchor">
              <button
                type="button"
                class="nyxus-rail-action"
                :disabled="creating"
                aria-label="新建会话"
                @click="createSession"
              >
                <span aria-hidden="true">＋</span>
              </button>
            </span>
          </el-tooltip>
          <div class="nyxus-piano-tool" @pointerenter="showPiano" @focusin="showPiano" @pointerleave="schedulePianoClose">
            <button
              type="button"
              class="nyxus-rail-action"
              :class="{ 'is-active': pianoOpen }"
              aria-label="会话钢琴"
              :aria-expanded="pianoOpen"
              @click="showPiano"
            >
              <span aria-hidden="true">▥</span>
            </button>
          </div>
          <el-tooltip
            :content="`查看上下文 · ${treeUsagePct}%`"
            placement="left"
            :show-after="200"
            :hide-after="0"
          >
            <span class="nyxus-tool-tip-anchor">
              <el-popover
                trigger="click"
                placement="left"
                :width="460"
                popper-class="prompt-snapshot-popper"
                @show="onTreePromptSnapShow"
              >
                <template #reference>
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    :disabled="!chatId"
                    :aria-label="`查看上下文 · ${treeUsagePct}%`"
                  >
                    <span aria-hidden="true">◍</span>
                  </button>
                </template>
                <PromptSnapshotTip
                  v-if="treePromptSnap"
                  :system-prompt="treePromptSnap.systemPrompt"
                  :tools="treePromptSnap.tools"
                  :status="treePromptSnap.status"
                  :error="treePromptSnap.error"
                />
              </el-popover>
            </span>
          </el-tooltip>
        </div>
        <div class="nyxus-tool-group is-secondary" role="group" aria-label="视图与配置工具">
          <el-tooltip
            v-if="!isNyxus"
            content="返回快速发送窗口"
            placement="left"
            :show-after="200"
            :hide-after="0"
          >
            <span class="nyxus-tool-tip-anchor">
              <button
                type="button"
                class="nyxus-rail-action"
                aria-label="返回快速发送窗口"
                @click="closeWorkbench"
              >
                <span aria-hidden="true">↙</span>
              </button>
            </span>
          </el-tooltip>
          <div
            class="nyxus-fold-tool"
            :class="{ 'is-open': foldToolOpen }"
            @pointerenter="showFoldTool"
            @focusin="showFoldTool"
            @pointerleave="scheduleFoldToolClose"
          >
            <el-tooltip
              v-for="mode in (['none', 'partial', 'participant', 'full'] as FoldMode[])"
              :key="mode"
              :content="FOLD_TIPS[mode]"
              placement="top"
              :show-after="200"
              :hide-after="0"
            >
              <button
                type="button"
                class="nyxus-fold-part"
                :class="{ 'is-selected': foldMode === mode }"
                :aria-label="FOLD_TIPS[mode]"
                :aria-pressed="foldMode === mode"
                @click="selectFoldMode(mode)"
              >
                <svg class="nyxus-fold-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    v-for="path in FOLD_ICONS[mode].paths"
                    :key="path"
                    class="nyxus-fold-icon-edge"
                    :d="path"
                  />
                  <circle
                    v-for="([cx, cy], index) in FOLD_ICONS[mode].nodes"
                    :key="`${cx}-${cy}-${index}`"
                    class="nyxus-fold-icon-node"
                    :cx="cx"
                    :cy="cy"
                    r="1.65"
                  />
                </svg>
              </button>
            </el-tooltip>
            <span class="nyxus-fold-current" aria-hidden="true">
              <svg class="nyxus-fold-icon" viewBox="0 0 24 24">
                <path
                  v-for="path in FOLD_ICONS[foldMode].paths"
                  :key="path"
                  class="nyxus-fold-icon-edge"
                  :d="path"
                />
                <circle
                  v-for="([cx, cy], index) in FOLD_ICONS[foldMode].nodes"
                  :key="`${cx}-${cy}-${index}`"
                  class="nyxus-fold-icon-node"
                  :cx="cx"
                  :cy="cy"
                  r="1.65"
                />
              </svg>
            </span>
          </div>
          <div class="nyxus-role-tool" @pointerenter="showRoleList" @focusin="showRoleList" @pointerleave="scheduleRoleListClose">
            <button
              type="button"
              class="nyxus-rail-action"
              :class="{ 'is-active': roleListOpen }"
              aria-label="角色配置"
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
      <AnimatePresence>
        <MotionDiv
          v-if="workspaceBrowserMode"
          key="workspace-drawer-mask"
          class="workspace-drawer-mask"
          aria-hidden="true"
          :initial="{ opacity: 0 }"
          :animate="{ opacity: 1 }"
          :exit="{ opacity: 0 }"
          :transition="{ duration: 0.18 }"
          @click="toggleWorkspaceBrowser('attention')"
        />
        <MotionDiv
          v-if="workspaceBrowserMode"
          key="workspace-drawer"
          class="workspace-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="待处理交互"
          :initial="{ transform: 'translateX(100%)' }"
          :animate="{ transform: 'translateX(0)' }"
          :exit="{ transform: 'translateX(100%)' }"
          :transition="{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }"
        >
          <header class="workspace-drawer-head">
            <strong>待处理交互</strong>
            <span v-if="workspaceAttentionCount">{{ workspaceAttentionCount }} 项待处理</span>
            <button
              type="button"
              class="workspace-drawer-close"
              aria-label="关闭待处理交互"
              title="关闭"
              @click="toggleWorkspaceBrowser('attention')"
            >
              ✕
            </button>
          </header>
          <div class="workspace-drawer-body">
            <WorkspaceSessionBrowser
              :sessions="workspaceChats"
              @tree="openWorkspaceTree"
            />
          </div>
        </MotionDiv>
      </AnimatePresence>
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
  </MotionDiv>
</template>

<style scoped lang="less">
@import './agentDialog.less';

.role-usage-chip {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
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
  color: var(--nx-text);
  background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%);
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
  color: color-mix(in srgb, var(--nx-text) 90%, transparent);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--nx-bg) 96%, var(--nx-text) 4%),
    color-mix(in srgb, var(--nx-bg) 88%, var(--nx-text) 6%)
  );
  border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
  cursor: default;
  user-select: none;
}
.workbench-titlebar.is-draggable {
  cursor: grab;
}
.workbench-titlebar.is-draggable:active {
  cursor: grabbing;
}
// Phase E：需用户操作时标题栏暖橙外发光闪烁（非聚焦窗由 store 置位）。
.workbench-titlebar.has-attention {
  animation: workbench-box-blink 1.1s ease-in-out infinite;
}
@keyframes workbench-box-blink {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(246, 183, 60, 0);
    border-bottom-color: rgba(138, 211, 228, 0.14);
  }
  50% {
    box-shadow: 0 0 16px 1px rgba(246, 183, 60, 0.55);
    border-bottom-color: rgba(246, 183, 60, 0.55);
  }
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
  color: color-mix(in srgb, var(--nx-text) 56%, transparent);
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
  color: color-mix(in srgb, var(--nx-text) 86%, transparent);
  background: transparent;
  cursor: default;
  transition:
    color 100ms ease,
    background-color 100ms ease;
}
.window-control:hover,
.window-control:focus-visible {
  color: var(--nx-text);
  background: color-mix(in srgb, var(--nx-text) 12%, transparent);
}
.window-control.is-close:hover,
.window-control.is-close:focus-visible {
  background: var(--nx-red);
}
.window-control:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--nx-cyan) 86%, transparent);
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
  background: var(--nx-bg);
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
  background: var(--nx-bg);
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
  border: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
  border-radius: 10px;
  color: color-mix(in srgb, var(--nx-text) 64%, transparent);
  background: color-mix(in srgb, var(--nx-bg) 55%, transparent);
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
  color: var(--nx-text);
  border-color: color-mix(in srgb, var(--nx-green) 24%, transparent);
  background: color-mix(in srgb, var(--nx-green) 22%, transparent);
}
.nyxus-rail-action.is-message {
  color: var(--nx-cyan);
}
.nyxus-rail-action.is-stop {
  color: var(--nx-red);
}
.nyxus-rail-action.is-resume {
  color: var(--nx-green);
}
/* 分组间用一条分割线切割，不做边框盒子；按钮与发送按钮同款 rail-action。 */
.nyxus-tool-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
  pointer-events: auto;
}
.nyxus-tool-group.is-secondary {
  border-top-color: color-mix(in srgb, var(--nx-text) 12%, transparent);
  /* 折叠按钮变宽时会撑宽本组；右对齐让角色按钮等保持贴 rail 边缘，不随折叠按钮左移。 */
  align-items: flex-end;
}
.nyxus-piano-tool,
.nyxus-role-tool,
.nyxus-fold-tool {
  position: relative;
}
.nyxus-tool-tip-anchor {
  display: inline-flex;
  width: 30px;
  height: 30px;
}
/* 折叠四档按钮：复用同一个外边框，hover 时水平变宽，左侧滑出 4 个子按钮，
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
  border: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
  border-radius: 10px;
  color: color-mix(in srgb, var(--nx-text) 64%, transparent);
  background: color-mix(in srgb, var(--nx-bg) 55%, transparent);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(9px) saturate(115%);
  pointer-events: auto;
  transition: width 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.nyxus-fold-tool.is-open {
  /* 4 个子按钮(30 各) + 当前 icon(30) + 3×2 gap */
  width: 156px;
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
  color: var(--nx-text);
}
.nyxus-fold-icon {
  width: 18px;
  height: 18px;
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.45;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nyxus-fold-icon-edge {
  opacity: 0.72;
}
.nyxus-fold-icon-node {
  fill: color-mix(in srgb, currentColor 18%, var(--nx-bg));
  stroke-width: 1.35;
}
.nyxus-fold-part:hover .nyxus-fold-icon-edge,
.nyxus-fold-part.is-selected .nyxus-fold-icon-edge,
.nyxus-fold-current .nyxus-fold-icon-edge {
  opacity: 1;
}
.nyxus-fold-part.is-selected .nyxus-fold-icon-node,
.nyxus-fold-current .nyxus-fold-icon-node {
  fill: color-mix(in srgb, currentColor 34%, var(--nx-bg));
}
.nyxus-rail-action:active:not(:disabled) {
  transform: scale(0.97);
}
.nyxus-rail-action:disabled {
  cursor: not-allowed;
  opacity: 0.36;
}
.nyxus-rail-action:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--nx-cyan) 86%, transparent);
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
  background: var(--nx-red);
  font-size: 8px;
  line-height: 15px;
}
.workspace-drawer-mask {
  position: absolute;
  z-index: var(--nx-z-drawer-mask);
  inset: 40px 0 0 0; /* 从标题栏下方开始，永遮不住上方关闭/最大化/最小化按钮 */
  background: rgba(2, 8, 12, 0.5);
  backdrop-filter: blur(2px);
  pointer-events: auto;
}
// 右侧抽屉：内容区内部满高，盖住右侧 rail 与 ctx-bar，遮罩之下须关闭抽屉才能继续使用。
.workspace-drawer {
  position: absolute;
  z-index: var(--nx-z-drawer);
  top: 40px;
  right: 0;
  bottom: 0;
  width: min(440px, 72%);
  display: flex;
  flex-direction: column;
  color: var(--ink);
  background: var(--panel);
  border-left: 1px solid color-mix(in srgb, var(--nx-text) 16%, transparent);
  box-shadow: -18px 0 40px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
}
.workspace-drawer-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
}
.workspace-drawer-head strong {
  color: var(--ink);
  font-size: 13px;
}
.workspace-drawer-head span {
  flex: 1;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 10px;
}
.workspace-drawer-close {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  background: transparent;
  font-size: 13px;
  cursor: pointer;
  transition:
    color 100ms ease,
    background-color 100ms ease;
}
.workspace-drawer-close:hover,
.workspace-drawer-close:focus-visible {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 12%, transparent);
}
.workspace-drawer-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
// 抽屉内复用 WorkspaceSessionBrowser：隐藏其自带 header（计数移至抽屉头），列表撑满滚动。
.workspace-drawer :deep(.workspace-browser) {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.workspace-drawer :deep(.browser-head) {
  display: none;
}
.workspace-drawer :deep(.browser-list) {
  flex: 1;
  min-height: 0;
  max-height: none;
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

// 节点树上下文占用条：定位容器（标题栏下方 40px 处，分割线位置）。
// 视觉由共享组件 ContextUsageBar variant="divider" 渲染：默认仅 4px 细线
// （track 底色即分割线，无数据也可见）；hover 时条变宽并展开图例/数值。
.workbench-ctx-bar {
  position: absolute;
  z-index: var(--nx-z-chrome);
  top: 40px;
  right: 0;
  left: 0;
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
  border: 1px solid var(--nx-border);
  border-radius: 12px;
  color: var(--nx-text);
  background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%);
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.48),
    0 0 0 1px color-mix(in srgb, var(--nx-cyan) 6%, transparent);
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
  border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
  background: color-mix(in srgb, var(--nx-bg) 78%, var(--nx-text) 6%);
}
.nyxus-composer-status {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--nx-green);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--nx-green) 10%, transparent);
}
.nyxus-composer-title {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.nyxus-composer-title strong {
  color: var(--nx-text);
  font-size: 12px;
  line-height: 1.2;
}
.nyxus-composer-title small {
  overflow: hidden;
  color: color-mix(in srgb, var(--nx-text) 60%, transparent);
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
  color: color-mix(in srgb, var(--nx-text) 70%, transparent);
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
  color: color-mix(in srgb, var(--nx-text) 56%, transparent);
  font-size: 9px;
}
.nyxus-composer-hint kbd {
  padding: 1px 4px;
  border: 1px solid var(--nx-border-soft);
  border-radius: 4px;
  color: color-mix(in srgb, var(--nx-text) 78%, transparent);
  background: color-mix(in srgb, var(--nx-text) 6%, transparent);
  font: inherit;
}
// 节点树 composer 内置角色编制：与 composer 主体分隔，顶部留白让浅色 chip 不贴 dock 边缘。
.nyxus-role-configs {
  padding: 8px 14px 5px;
  border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
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
  .nyxus-rail-action:hover:not(:active):not(:disabled) {
    color: var(--nx-text);
    background: color-mix(in srgb, var(--nx-green) 11%, transparent);
  }
  .nyxus-composer-close:hover:not(:disabled) {
    color: var(--nx-text);
    border-color: color-mix(in srgb, var(--nx-cyan) 22%, transparent);
    background: color-mix(in srgb, var(--nx-cyan) 7%, transparent);
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
  .workbench-titlebar.has-attention {
    animation: none;
  }
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
  .nyxus-composer-close {
    transform: none !important;
    transition-duration: 0ms, 120ms, 120ms, 120ms;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .nyxus-rail-action,
  .nyxus-composer-dock {
    background: color-mix(in srgb, var(--nx-bg) 92%, var(--nx-text) 6%);
    backdrop-filter: none;
  }
}
@media (prefers-contrast: more) {
  .nyxus-rail-action,
  .nyxus-composer-dock {
    border-color: currentcolor;
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
  color: var(--ink);
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
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-hover);
  box-shadow: 0 7px 18px rgba(20, 22, 26, 0.18);
  color: var(--ink);
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
  color: color-mix(in srgb, var(--ink) 76%, transparent);
}

.instruction-token-floating-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--accent-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
}
</style>
