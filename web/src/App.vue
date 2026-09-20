<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
} from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import NyxusCore from '@/features/pets/nyxus/components/NyxusCore.vue'
import { ElMessage, ElTooltip } from 'element-plus'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import {
  createHistoryDrawerManager,
  HISTORY_DRAWER_MANAGER_KEY,
} from '@/features/agent/drawer/useHistoryDrawerManager'
import {
  useConnectionStore,
  useAgentsStore,
  useChatSessionsStore,
  useWorkspaceStore,
  useThemeStore,
  useAuthStore,
} from '@/stores'
import { startApplicationRuntime } from '@/application/runtime/startApplicationRuntime'
import { renderQualityTier } from '@/composables/renderQuality'
import { useClickFxLayer } from '@/composables/useClickFxLayer'
import { installPerformanceDiagnostics } from '@/utils/performanceDiagnostics'
import { visualEventWindow } from '@/features/desktop/visualEvents'
import type { TerminalHeaderMeta } from '@/features/agent/workbench/terminal/WorkbenchTerminal.vue'

// Electron 的每种 surface 与浏览器 overlay 互斥。重界面按实际状态下载，避免冷启动时
// 同时解析设置、历史、会话和 Pixi 工作台，并确保关闭后组件实例及其图形资源可回收。
const DesktopSurface = defineAsyncComponent(() => import('@/features/desktop/DesktopSurface.vue'))
const LoginSurface = defineAsyncComponent(() => import('@/features/desktop/LoginSurface.vue'))
const WindowFrame = defineAsyncComponent(() => import('@/features/desktop/WindowFrame.vue'))
const ConnectionStatusChip = defineAsyncComponent(
  () => import('@/features/desktop/ConnectionStatusChip.vue'),
)
const WorkbenchSessionBar = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchSessionBar.vue'),
)
const CyberDesktopHost = defineAsyncComponent(
  () => import('@/features/desktop/CyberDesktopHost.vue'),
)
const CyberWindow = defineAsyncComponent(() => import('@/features/desktop/CyberWindow.vue'))
const AgentDialog = defineAsyncComponent(() => import('@/features/agent/chat/AgentDialog.vue'))
const WorkbenchDialog = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchDialog.vue'),
)
const TerminalSurface = defineAsyncComponent(
  () => import('@/features/agent/workbench/terminal/TerminalSurface.vue'),
)
const WorkbenchViewToggle = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchViewToggle.vue'),
)
const HistoryDrawer = defineAsyncComponent(
  () => import('@/features/agent/drawer/HistoryDrawer.vue'),
)
const SettingsDialog = defineAsyncComponent(
  () => import('@/features/agent/settings/SettingsDialog.vue'),
)
const OpenConfigDirButton = defineAsyncComponent(
  () => import('@/features/agent/settings/components/OpenConfigDirButton.vue'),
)
const TaskCenterPanel = defineAsyncComponent(
  () => import('@/features/agent/task-center/TaskCenterPanel.vue'),
)

// 鉴权非强制：本地直连不鉴权；远端由 cheryNyxus 登录弹窗对接（token 存 auth store）。
// surface 分发：desktop（Electron 全工作区透明宠物窗）/ settings（Electron 原生设置窗）/
// workbench（Electron 每预设一工作台原生窗）/ undefined（浏览器完整单页）。
// 四个 Electron/浏览器面都直连 WS（后端按连接扇出）。
// 节点树工作台多窗口：浏览器面每预设一窗（windowId = presetId），由 workbenchWindowsList 驱动渲染；
// Electron workbench 面本窗 store 只含一条记录（原生窗本身即"每预设一窗"）。
const agents = useAgentsStore()
const workspace = useWorkspaceStore()
const chatSessions = useChatSessionsStore()
const query = new URLSearchParams(window.location.search)
const surface = query.get('surface')
const surfacePresetId = query.get('presetId') ?? undefined
/** 入口携带的预设名（workbench 窗空白态角色编制解析；main extraParams 拼入 URL）。 */
const surfacePresetName = query.get('presetName') ?? undefined
const surfaceTerminalPresetId = query.get('presetId') ?? undefined
const surfaceChatId = query.get('chatId') ?? undefined
const surfaceSettingsSection = query.get('settingsSection') as
  'provider' | 'runtime' | 'limits' | null
const surfaceSource = query.get('source') as 'pet' | 'history' | 'nyxus' | null
const surfaceView = query.get('view') as 'composer' | 'attention' | 'tree' | null
const terminalSurfaceRef = ref<{ clear: () => void } | null>(null)
const terminalHeaderMeta = ref<TerminalHeaderMeta>({ username: '', host: '', status: 'idle' })
const browserTerminalHeaders = reactive<Record<string, TerminalHeaderMeta>>({})
const browserTerminalRefs = new Map<string, { clear: () => void }>()
const terminalConnectionLabel = computed(
  () =>
    ({ idle: '未连接', connecting: '连接中', connected: '已连接', exited: '已断开' })[
      terminalHeaderMeta.value.status
    ],
)
function updateTerminalHeader(meta: TerminalHeaderMeta): void {
  terminalHeaderMeta.value = meta
}
function browserTerminalHeader(windowId: string): TerminalHeaderMeta {
  return browserTerminalHeaders[windowId] ?? { username: '', host: '', status: 'idle' }
}
function updateBrowserTerminalHeader(windowId: string, meta: TerminalHeaderMeta): void {
  browserTerminalHeaders[windowId] = meta
}
function setBrowserTerminalRef(windowId: string, instance: unknown): void {
  if (instance && typeof instance === 'object' && 'clear' in instance) {
    browserTerminalRefs.set(windowId, instance as { clear: () => void })
  } else {
    browserTerminalRefs.delete(windowId)
    delete browserTerminalHeaders[windowId]
  }
}

// 点击特效层：全部 surface（浏览器单页 + 各 Electron 面）挂载；桌面透明窗走透明窗官方配置。
// 是否启用由 useClickFxLayer 内部监听偏好与动效模式（reduced 时自动关闭）。
useClickFxLayer({ transparentWindow: surface === 'desktop' })

const reportedRunFailures = new Set<string>()
watch(
  () =>
    Object.values(chatSessions.sessionsById).flatMap((session) => {
      const failure = session.run.errorFact
      if (!failure) return []
      return [
        {
          key: `${session.chatId}:${failure.tracingId ?? failure.code}:${failure.message}`,
          chatId: session.chatId,
          failure,
        },
      ]
    }),
  (failures) => {
    if (surface) return
    for (const { key, chatId, failure } of failures) {
      if (reportedRunFailures.has(key)) continue
      reportedRunFailures.add(key)
      workspace.openOrFocusWindow(
        visualEventWindow({
          type: 'failure',
          source: String(failure.source ?? 'run'),
          message: failure.message,
          code: failure.code,
          chatId,
        }),
      )
    }
  },
  { deep: true },
)

/** workbench 原生窗三视图切换（树/对话/精简，§2.1 扩展）：标题栏与 WorkbenchDialog 共享
 * useWorkbenchViewMode，保证 Electron 面（surface=workbench）与浏览器面状态一致。
 * 非 workbench 面 windowId 兜底无害。 */
// 历史抽屉跨层管理层：顶层 provide，供 SpawnRenderer「详情」/ HistoryDrawer / panel inject（不耦合 store 数据层）
provide(HISTORY_DRAWER_MANAGER_KEY, createHistoryDrawerManager())

// ── composer 原生窗（surface==='composer'）：WindowFrame 外壳承载标题栏与三键 ──
// 标题 = 当前会话 pet 名（回退预设名）；🌳 节点树 / ! 待处理交互能力按钮经 title-actions
// slot 放靠左标题后，操作经 AgentDialog defineExpose 暴露调用（native 面自身隐藏 dialog-head）。
interface AgentDialogExpose {
  openWorkbenchForChat: () => void
  openWorkspaceTree: (
    rootChatId: string,
    sourceChatId?: string,
    interactionId?: string,
    anchorNodeId?: string,
  ) => Promise<void>
  closeDialog: () => void
  toggleAttention: () => void
  getWorkspaceAttentionCount: () => number
  isAttentionView: () => boolean
}
const agentDialogRef = ref<AgentDialogExpose | null>(null)
/** composer 窗当前会话：初始 surfaceChatId，main `surface:retarget` 切换后跟随 activeDialogChatId。 */
const composerChatId = computed(() => workspace.activeDialogChatId)
const composerTitle = computed(() => {
  const chatId = composerChatId.value
  if (!chatId) return '发消息'
  const pet = agents.petForChat(chatId)
  if (pet?.name) return pet.name
  const summary = chatSessions.catalogSummaries.find((item) => item.chatId === chatId)
  return summary?.preset ?? surfacePresetId ?? '发消息'
})
const composerAttentionActive = computed(() => agentDialogRef.value?.isAttentionView() ?? false)
const composerAttentionCount = computed(
  () => agentDialogRef.value?.getWorkspaceAttentionCount() ?? 0,
)

watch(
  () => workspace.activeDialogChatId,
  (chatId, previous) => {
    if (chatId) {
      workspace.openOrFocusWindow({
        resourceKey: `session:${chatId}`,
        title: composerTitle.value,
        context: { kind: 'session', chatId },
        geometry: { width: 860, height: 680 },
      })
    } else if (previous) {
      workspace.beginWorkspaceWindowClose(`window:session:${previous}`)
    }
  },
  { immediate: true },
)
watch(
  () => workspace.settingsOpen,
  (open) => {
    if (open) {
      workspace.openOrFocusWindow({
        resourceKey: 'settings',
        title: '系统配置',
        context: { kind: 'settings', section: workspace.settingsSection ?? undefined },
        geometry: { width: 1120, height: 760 },
      })
    } else {
      workspace.beginWorkspaceWindowClose('window:settings')
    }
  },
  { immediate: true },
)
watch(
  [() => workspace.topHistoryChatId, () => workspace.historyDrawerMode],
  ([chatId, mode], previous) => {
    const previousChatId = previous?.[0]
    if (chatId && mode === 'overlay') {
      workspace.openOrFocusWindow({
        resourceKey: `history:${chatId}`,
        title: '档案 // 会话追踪',
        context: { kind: 'history', rootChatId: chatId },
        geometry: { width: 1040, height: 760 },
      })
    } else if (previousChatId) {
      workspace.beginWorkspaceWindowClose(`window:history:${previousChatId}`)
    }
  },
  { immediate: true },
)

const browserSessionWindow = computed(() =>
  [...workspace.workspaceWindowsList]
    .reverse()
    .find(
      (window) =>
        window.context.kind === 'session' &&
        (window.context.chatId === workspace.activeDialogChatId || window.lifecycle === 'closing'),
    ),
)
const browserSettingsWindow = computed(() => workspace.workspaceWindows['window:settings'])
const browserTerminalWindows = computed(() =>
  workspace.workspaceWindowsList.filter((window) => window.context.kind === 'terminal'),
)
const browserHistoryWindow = computed(() =>
  [...workspace.workspaceWindowsList]
    .reverse()
    .find(
      (window) =>
        window.context.kind === 'history' &&
        (window.context.rootChatId === workspace.topHistoryChatId ||
          window.lifecycle === 'closing'),
    ),
)
const browserTaskCenterWindow = computed(() => workspace.workspaceWindows['window:task-center'])
const browserWorkbenchWindows = computed(() =>
  workspace.workbenchWindowsList.flatMap((workbench) => {
    const window = workspace.workspaceWindows[`window:graph:${workbench.id}`]
    return window ? [{ workbench, window }] : []
  }),
)

const settingsDialogRef = ref<{
  confirmClose: () => Promise<boolean>
  close: () => Promise<void>
} | null>(null)

async function requestCyberWindowClose(id: string): Promise<void> {
  if (workspace.workspaceWindows[id]?.context.kind === 'settings') {
    if (!(await settingsDialogRef.value?.confirmClose())) return
  }
  workspace.beginWorkspaceWindowClose(id)
}

function minimizeCyberWindow(id: string): void {
  const window = workspace.workspaceWindows[id]
  if (window?.context.kind === 'graph') {
    workspace.setWorkbenchWindowMinimized(window.context.presetId, true)
    return
  }
  workspace.minimizeWorkspaceWindow(id)
}

function focusTaskCenterWindow(id: string): void {
  workspace.setWorkspaceWindowAttention(id, false)
  workspace.focusWorkspaceWindow(id)
}

function finishCyberWindowClose(id: string): void {
  const window = workspace.workspaceWindows[id]
  if (
    window?.context.kind === 'session' &&
    workspace.activeDialogChatId === window.context.chatId
  ) {
    workspace.activeDialogChatId = null
  }
  if (window?.context.kind === 'settings') workspace.settingsOpen = false
  if (window?.context.kind === 'history') workspace.closeAllHistory()
  if (window?.context.kind === 'graph') {
    workspace.closeWorkbenchWindow(window.context.presetId)
    return
  }
  workspace.removeWorkspaceWindow(id)
}
/** composer 窗内按需水合会话树（与 PetStage 点击路径同语义；desktop 面不再负责）。 */
function hydrateComposerChat(chatId: string): void {
  void chatSessions
    .hydrateTree(chatId)
    .catch((e) => console.warn(`[App] hydrateTree ${chatId} 失败:`, e))
}

if (surface === 'composer' && surfaceChatId) {
  workspace.activeDialogChatId = surfaceChatId
  workspace.activeDialogSource = surfaceSource ?? 'history'
  workspace.activeDialogView = surfaceView ?? 'composer'
  hydrateComposerChat(surfaceChatId)
}
if (surface === 'history' && surfaceChatId) workspace.openHistoryRoot(surfaceChatId)

// Electron settings/workbench 原生窗桥接：跨窗主题同步 + backgroundColor 灰边兜底。
// desktop 面不接（透明宠物窗，setBackgroundColor 会把窗铺成不透明底色，破坏透明；锁 color-scheme 已由 DesktopSurface 处理）。
const electronBridgeCleanup: Array<() => void> = []
let workbenchBridgeCleanup: Array<() => void> = []
function bindElectronThemeBridge(): void {
  const bridge = desktopBridge()
  if (!bridge) return
  const themeStore = useThemeStore()
  const transparentSurface = surface === 'desktop'
  // 读当前主题 --bg（theme.css 已定义），回写原生窗底色（首帧 / resize 边缘兜底，防灰边）
  const applyWindowBackground = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    if (bg && !transparentSurface) bridge.setBackgroundColor(bg)
  }
  // 本窗主动切换（toggle 触发 notifyChanged）→ 广播其它窗
  electronBridgeCleanup.push(themeStore.onChanged((t) => bridge.emitThemeChanged(t)))
  // 接收其它窗广播 → 应用（applyFrom 不 notify，避免 toggle→emit→applyFrom→emit 回环）
  electronBridgeCleanup.push(bridge.onThemeSet((t) => themeStore.applyFrom(t)))
  // 每次主题应用后同步原生窗底色
  electronBridgeCleanup.push(themeStore.onChanged(applyWindowBackground))
  electronBridgeCleanup.push(bridge.onThemeSet(applyWindowBackground))
  electronBridgeCleanup.push(
    bridge.onAuthChanged(() => {
      useAuthStore().reloadFromStorage()
      void useConnectionStore().reconnect()
    }),
  )
  applyWindowBackground()
}

if (surface === 'composer' || surface === 'history') {
  const bridge = desktopBridge()
  if (bridge) {
    workbenchBridgeCleanup.push(
      bridge.onSurfaceRetarget((target) => {
        if (surface === 'composer') {
          workspace.activeDialogChatId = target.chatId
          workspace.activeDialogSource = target.source ?? 'history'
          workspace.activeDialogView = target.view ?? 'composer'
          hydrateComposerChat(target.chatId)
        } else {
          workspace.openHistoryRoot(target.chatId)
        }
      }),
    )
  }
}

if (surface === 'history') {
  let historyOpened = !!surfaceChatId
  workbenchBridgeCleanup.push(
    watch(
      () => workspace.historyDrawerStack.length,
      (length) => {
        if (length > 0) historyOpened = true
        else if (historyOpened) desktopBridge()?.windowControl('close')
      },
    ),
  )
}

// workbench 面：注册必须在渲染前同步完成（WorkbenchDialog setup 读 store 的 win.value）。
if (surface === 'workbench' && surfacePresetId) {
  const wbId = workspace.openWorkbenchWindow(surfacePresetId, surfacePresetName)
  // 与入口语义一致：仅新建窗口恢复会话（chatId 为空时才设置），重开复用不覆盖浏览
  if (surfaceChatId && !workspace.workbenchWindows[wbId]?.chatId) {
    workspace.setWorkbenchWindowChat(wbId, surfaceChatId)
  }
  const bridge = desktopBridge()
  if (bridge) {
    // main 下发「打开节点树」定位 / 会话切换 → 写本窗 store
    workbenchBridgeCleanup.push(
      bridge.onWorkbenchFocus((focus) => {
        workspace.setWorkbenchWindowView(wbId, 'tree')
        workspace.setWorkbenchWindowFocus(wbId, focus)
      }),
    )
    workbenchBridgeCleanup.push(
      bridge.onOpenChat((chatId) => workspace.setWorkbenchWindowChat(wbId, chatId)),
    )
    // attentionBlink（Phase E 审批/提问闪烁）→ 原生任务栏闪烁
    workbenchBridgeCleanup.push(
      watch(
        () => workspace.workbenchWindows[wbId]?.attentionBlink,
        (blink) => bridge.flashFrame(!!blink),
      ),
    )
  }
}

// workbench 面：presetId = 配置稳定 ID（windowId 同值；标题显示用预设名）；外层 WindowFrame 承载。
const wbRef = ref<{
  closeWorkbench: () => void
  toggleFilesWorkspace: () => void
  closeFilesWorkspace: () => void
  closeTaskBrowser: () => void
  getFilesOpen: () => boolean
} | null>(null)
type WorkbenchDialogHandle = { toggleFilesWorkspace: () => void; closeFilesWorkspace: () => void; closeTaskBrowser: () => void; getFilesOpen: () => boolean }
const browserWorkbenchRefs = new Map<string, WorkbenchDialogHandle>()
function setBrowserWorkbenchRef(
  windowId: string,
  instance: unknown,
): void {
  if (instance && typeof instance === 'object' && 'toggleFilesWorkspace' in instance) {
    browserWorkbenchRefs.set(windowId, instance as WorkbenchDialogHandle)
  } else {
    browserWorkbenchRefs.delete(windowId)
  }
}
function toggleBrowserWorkbenchFiles(windowId: string): void {
  browserWorkbenchRefs.get(windowId)?.closeTaskBrowser()
  browserWorkbenchRefs.get(windowId)?.toggleFilesWorkspace()
}
function closeNativeWorkbenchTasks(): void { wbRef.value?.closeTaskBrowser() }
function closeNativeWorkbenchFiles(): void { wbRef.value?.closeTaskBrowser(); wbRef.value?.toggleFilesWorkspace() }
/** Phase E 闪烁回推：本窗 attentionBlink → WindowFrame 标题栏暖橙外发光（任务栏闪烁已在注册块处理）。 */
const surfaceWindowBlink = computed(
  () =>
    (surfacePresetId ? workspace.workbenchWindows[surfacePresetId]?.attentionBlink : false) ??
    false,
)
/** 点击 WindowFrame 标题栏视为用户已注意到该窗口 → 熄灭闪烁（与浏览器路径 onTitlePointerDown 同语义）。 */
function onWorkbenchTitlePointerDown(): void {
  if (surfacePresetId) workspace.setWorkbenchWindowBlink(surfacePresetId, false)
}
/** workbench 原生窗标题栏会话状态条：当前窗会话（store 注册表响应式），strip 高亮用。 */
const workbenchSurfaceChatId = computed(
  () => workspace.workbenchWindows[surfacePresetId ?? '']?.chatId ?? null,
)
/** 会话切换（与 bridge.onOpenChat 同语义：setWorkbenchWindowChat，WorkbenchDialog 内 watch chatId 驱动树订阅）。 */
function onWorkbenchSessionSelect(chatId: string): void {
  if (!surfacePresetId) return
  workspace.setWorkbenchWindowChat(surfacePresetId, chatId)
}
/** 标题栏「打开配置文件夹」失败：标题栏入口独立于 SettingsDialog 内部错误弹窗，用轻量消息提示。 */
function onSettingsOpenDirError(message: string): void {
  ElMessage.error(message)
}

onMounted(() => {
  stopPerformanceDiagnostics = installPerformanceDiagnostics(() => renderQualityTier.value)
  bindElectronThemeBridge()
  void bootstrap()
})
onBeforeUnmount(() => {
  stopApplicationRuntime?.()
  stopPerformanceDiagnostics?.()
  electronBridgeCleanup.splice(0).forEach((cleanup) => cleanup())
  workbenchBridgeCleanup.splice(0).forEach((cleanup) => cleanup())
})

let stopApplicationRuntime: (() => void) | undefined
let stopPerformanceDiagnostics: (() => void) | undefined

async function bootstrap(): Promise<void> {
  stopApplicationRuntime = startApplicationRuntime()
}
</script>

<template>
  <DesktopSurface v-if="surface === 'desktop'" />
  <!-- composer 原生窗：复用 WindowFrame 公共外壳（与 settings/workbench 统一），标题靠左显示 pet 名，
       能力按钮经 title-actions slot 放标题后（紧贴标题），三键保持最右；AgentDialog native 隐藏自绘标题栏 -->
  <WindowFrame v-else-if="surface === 'composer'" :title="composerTitle">
    <template #title-actions>
      <el-tooltip placement="bottom" :show-after="120" :hide-after="0">
        <template #content>
          <span>打开当前会话的节点树工作台</span>
        </template>
        <button
          type="button"
          class="composer-title-action"
          aria-label="打开当前会话节点树工作台"
          @click="agentDialogRef?.openWorkbenchForChat()"
        >
          🌳
        </button>
      </el-tooltip>
      <el-tooltip placement="bottom" :show-after="120" :hide-after="0">
        <template #content>
          <span>待处理交互（审批 / 提问）</span>
        </template>
        <button
          type="button"
          class="composer-title-action composer-title-attention"
          :class="{
            'is-active': composerAttentionActive,
            'has-attention': composerAttentionCount > 0,
          }"
          aria-label="待处理交互"
          :aria-pressed="composerAttentionActive"
          @click="agentDialogRef?.toggleAttention()"
        >
          !<b v-if="composerAttentionCount">{{ composerAttentionCount }}</b>
        </button>
      </el-tooltip>
    </template>
    <AgentDialog ref="agentDialogRef" native />
  </WindowFrame>
  <div v-else-if="surface === 'history'" class="history-native"><HistoryDrawer /></div>
  <WindowFrame v-else-if="surface === 'login'" channel="AUTH" title="ACCESS CONTROL // NYXUS_OS">
    <LoginSurface />
  </WindowFrame>
  <WindowFrame
    v-else-if="surface === 'settings'"
    title="设置"
    :close="
      () => {
        void settingsDialogRef?.close()
      }
    "
  >
    <!-- 标题位置扩展点：title-actions slot（标题右侧、三键左侧）——settings 面放「打开配置文件夹」 -->
    <template #title-actions>
      <OpenConfigDirButton @error="onSettingsOpenDirError" />
    </template>
    <SettingsDialog
      ref="settingsDialogRef"
      native
      :initial-section="surfaceSettingsSection ?? undefined"
    />
  </WindowFrame>
  <WindowFrame v-else-if="surface === 'task-center'" title="任务中心 // 多 Agent">
    <TaskCenterPanel />
  </WindowFrame>
  <!-- workbench 面同用 WindowFrame 公共外壳：标题=预设名，attentionBlink→标题栏闪烁，
       关闭经 closeWorkbench（先释放根时间线订阅再交 main hide 保活）；
       title-actions 放常驻连接状态 chip（断连遮罩由 WorkbenchDialog 内部渲染） -->
  <WindowFrame
    v-else-if="surface === 'terminal' && surfaceTerminalPresetId"
    class="terminal-window-frame"
    :title="surfacePresetName ? `Terminal // ${surfacePresetName}` : 'Terminal'"
  >
    <template #title-actions>
      <span v-if="terminalHeaderMeta.username || terminalHeaderMeta.host" class="terminal-title-connection">
        {{ terminalHeaderMeta.username }} · {{ terminalHeaderMeta.host }}
      </span>
      <span class="terminal-title-status" :data-status="terminalHeaderMeta.status">
        {{ terminalConnectionLabel }}
      </span>
      <button type="button" class="terminal-title-clear" @click="terminalSurfaceRef?.clear()">清空</button>
    </template>
    <TerminalSurface
      ref="terminalSurfaceRef"
      :preset-id="surfaceTerminalPresetId"
      @meta="updateTerminalHeader"
    />
  </WindowFrame>
  <WindowFrame
    v-else-if="surface === 'workbench'"
    :title="surfacePresetName ?? surfacePresetId ?? '节点树工作台'"
    :attention="surfaceWindowBlink"
    :close="() => wbRef?.closeWorkbench()"
    :title-pointer-down="onWorkbenchTitlePointerDown"
  >
    <template #title-actions>
      <ConnectionStatusChip />
      <!-- 标题栏稳定任务快捷位；切换走 onWorkbenchSessionSelect（setWorkbenchWindowChat，
           与 bridge.onOpenChat 同语义，WorkbenchDialog 内 watch chatId 驱动树订阅与 draft reset） -->
      <WorkbenchSessionBar
        :window-id="surfacePresetId ?? 'workbench'"
        :preset-id="surfacePresetId ?? undefined"
        :preset-name="surfacePresetName ?? undefined"
        :active-chat-id="workbenchSurfaceChatId"
        @select="onWorkbenchSessionSelect"
        @before-expand="() => wbRef?.closeFilesWorkspace()"
      />
      <button
        type="button"
        class="workbench-files-title-action"
        aria-label="打开文件工作区"
        :aria-pressed="wbRef?.getFilesOpen() ?? false"
        :disabled="!workbenchSurfaceChatId"
        @click="closeNativeWorkbenchFiles()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v9.5H3z" /><path d="M3 6.5V5h7l2 2" /></svg>
      </button>
      <!-- 三视图切换（树/对话/精简，§2.1 扩展）：native 面 WorkbenchDialog 内部 titlebar 被 v-if="!isNative"
           隐藏，切换入口放 WindowFrame title-actions，与 WorkbenchDialog 共享 useWorkbenchViewMode -->
      <WorkbenchViewToggle :window-id="surfacePresetId ?? 'workbench'" />
    </template>
    <WorkbenchDialog
      ref="wbRef"
      :window-id="surfacePresetId!"
      :preset-id="surfacePresetId!"
      native
    />
  </WindowFrame>
  <template v-else>
    <!-- 浏览器完整单页（不受 Electron 迁移影响）：应用内多工作台窗 + 胶囊 + overlay 设置 + 抽屉 -->
    <CyberDesktopHost>
      <PetStage transparent />
      <NyxusCore />
      <CyberWindow
        v-if="browserSessionWindow"
        :window="browserSessionWindow"
        @focus="workspace.focusWorkspaceWindow"
        @opened="workspace.markWorkspaceWindowOpen"
        @minimize="minimizeCyberWindow"
        @request-close="requestCyberWindowClose"
        @closed="finishCyberWindowClose"
        @geometry="workspace.setWorkspaceWindowGeometry"
        @toggle-maximize="workspace.toggleWorkspaceWindowMaximized"
      >
        <AgentDialog v-if="workspace.activeDialogChatId" embedded />
      </CyberWindow>
      <CyberWindow
        v-if="browserTaskCenterWindow"
        :window="browserTaskCenterWindow"
        @focus="focusTaskCenterWindow"
        @opened="workspace.markWorkspaceWindowOpen"
        @minimize="minimizeCyberWindow"
        @request-close="requestCyberWindowClose"
        @closed="finishCyberWindowClose"
        @geometry="workspace.setWorkspaceWindowGeometry"
        @toggle-maximize="workspace.toggleWorkspaceWindowMaximized"
      >
        <TaskCenterPanel />
      </CyberWindow>
      <CyberWindow
        v-if="browserHistoryWindow && workspace.historyDrawerMode === 'overlay'"
        :window="browserHistoryWindow"
        @focus="workspace.focusWorkspaceWindow"
        @opened="workspace.markWorkspaceWindowOpen"
        @minimize="minimizeCyberWindow"
        @request-close="requestCyberWindowClose"
        @closed="finishCyberWindowClose"
        @geometry="workspace.setWorkspaceWindowGeometry"
        @toggle-maximize="workspace.toggleWorkspaceWindowMaximized"
      >
        <HistoryDrawer embedded />
      </CyberWindow>
      <CyberWindow
        v-if="browserSettingsWindow"
        :window="browserSettingsWindow"
        @focus="workspace.focusWorkspaceWindow"
        @opened="workspace.markWorkspaceWindowOpen"
        @minimize="minimizeCyberWindow"
        @request-close="requestCyberWindowClose"
        @closed="finishCyberWindowClose"
        @geometry="workspace.setWorkspaceWindowGeometry"
        @toggle-maximize="workspace.toggleWorkspaceWindowMaximized"
      >
        <SettingsDialog v-if="workspace.settingsOpen" ref="settingsDialogRef" embedded />
      </CyberWindow>
      <CyberWindow
        v-for="terminalWindow in browserTerminalWindows"
        :key="terminalWindow.id"
        :window="terminalWindow"
        @focus="workspace.focusWorkspaceWindow"
        @opened="workspace.markWorkspaceWindowOpen"
        @minimize="minimizeCyberWindow"
        @request-close="requestCyberWindowClose"
        @closed="finishCyberWindowClose"
        @geometry="workspace.setWorkspaceWindowGeometry"
        @toggle-maximize="workspace.toggleWorkspaceWindowMaximized"
      >
        <template #title-actions>
          <span
            v-if="browserTerminalHeader(terminalWindow.id).username || browserTerminalHeader(terminalWindow.id).host"
            class="terminal-title-connection"
          >
            {{ browserTerminalHeader(terminalWindow.id).username }} · {{ browserTerminalHeader(terminalWindow.id).host }}
          </span>
          <span class="terminal-title-status" :data-status="browserTerminalHeader(terminalWindow.id).status">
            {{ ({ idle: '未连接', connecting: '连接中', connected: '已连接', exited: '已断开' })[browserTerminalHeader(terminalWindow.id).status] }}
          </span>
          <button type="button" class="terminal-title-clear" @click="browserTerminalRefs.get(terminalWindow.id)?.clear()">清空</button>
        </template>
        <TerminalSurface
          v-if="terminalWindow.context.kind === 'terminal'"
          :ref="(instance) => setBrowserTerminalRef(terminalWindow.id, instance)"
          :preset-id="terminalWindow.context.presetId"
          @meta="updateBrowserTerminalHeader(terminalWindow.id, $event)"
        />
      </CyberWindow>
      <CyberWindow
        v-for="entry in browserWorkbenchWindows"
        :key="entry.window.id"
        :window="entry.window"
        @focus="workspace.focusWorkbenchWindow(entry.workbench.id)"
        @opened="workspace.markWorkspaceWindowOpen"
        @minimize="minimizeCyberWindow"
        @request-close="requestCyberWindowClose"
        @closed="finishCyberWindowClose"
        @geometry="workspace.setWorkspaceWindowGeometry"
        @toggle-maximize="workspace.toggleWorkspaceWindowMaximized"
      >
        <template #title-actions>
          <ConnectionStatusChip />
          <!-- 标题栏稳定任务快捷位：浏览器面工作台窗由 CyberWindow 承载
               标题栏（WorkbenchDialog embedded 自绘 titlebar 不渲染），strip 挂此 slot；
               senseTool 不注入，strip 内部自拉 sense.tools 兜底 -->
          <WorkbenchSessionBar
            :window-id="entry.workbench.id"
            :preset-id="entry.workbench.presetId"
            :preset-name="entry.workbench.presetName ?? undefined"
            :active-chat-id="entry.workbench.chatId"
            :foreground="entry.window.focused"
            @select="(id: string) => workspace.setWorkbenchWindowChat(entry.workbench.id, id)"
            @before-expand="() => browserWorkbenchRefs.get(entry.workbench.id)?.closeFilesWorkspace()"
          />
          <button
            type="button"
            class="workbench-files-title-action"
            aria-label="打开文件工作区"
            :aria-pressed="browserWorkbenchRefs.get(entry.workbench.id)?.getFilesOpen() ?? false"
            :disabled="!entry.workbench.chatId"
            @click="toggleBrowserWorkbenchFiles(entry.workbench.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v9.5H3z" /><path d="M3 6.5V5h7l2 2" /></svg>
          </button>
          <WorkbenchViewToggle :window-id="entry.workbench.id" />
        </template>
        <WorkbenchDialog
          :ref="(instance) => setBrowserWorkbenchRef(entry.workbench.id, instance)"
          :window-id="entry.workbench.id"
          :preset-id="entry.workbench.presetId"
          embedded
        />
      </CyberWindow>
    </CyberDesktopHost>
  </template>
</template>

<style lang="less">
* {
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
}

body {
  overflow: hidden;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
}

.history-native {
  width: 100%;
  height: 100%;
  background: var(--bg);
  --drawer-w: 100%;
}

// composer 原生窗标题栏能力按钮（WindowFrame title-actions slot）：紧贴标题、垂直居中。
// title-actions 容器已 no-drag，按钮可正常点击（标题栏其余区域保持 OS 拖拽）。
.composer-title-action {
  position: relative;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    color 100ms ease,
    background-color 100ms ease;

  &:hover {
    background: var(--surface-hover);
    color: var(--ink);
  }
}
.composer-title-action.is-active {
  border-color: var(--violet);
  color: var(--violet);
  background: var(--violet-soft);
}
.composer-title-attention b {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 8px;
  line-height: 14px;
}
// 有待处理交互时充能高亮：accent 底 + accent-ink 文字 + 徽标脉动光晕（与 accept 按钮同风格，突出入口）。
// has-attention 声明在 is-active 之后 → 有待处理时 accent 底优先于紫色选中态，避免两色叠加混淆。
.composer-title-attention.has-attention {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  box-shadow: 0 1px 6px var(--accent-glow);

  &:hover {
    background: color-mix(in srgb, var(--accent) 86%, #000);
    color: var(--accent-ink);
  }
}
.composer-title-attention.has-attention b {
  background: #fff;
  color: #b73e0c;
  animation: composer-attention-badge-pulse 1.6s ease-in-out infinite;
}
@keyframes composer-attention-badge-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 50%, transparent);
    transform: scale(1);
  }
  50% {
    box-shadow: 0 0 0 4px transparent;
    transform: scale(1.12);
  }
}
/* workbench 原生窗 title-actions 的 lite 切换 switch（§2.1，与 WorkbenchDialog 内同名样式同观感；
   v1.0：原 ⚡ 按钮改 el-switch，主色轨道浅深适配，仅留间距） */
.workbench-lite-switch {
  -webkit-app-region: no-drag;
  pointer-events: auto;
  flex: none;
  margin-left: 8px;
  vertical-align: middle;
}
.workbench-files-title-action {
  -webkit-app-region: no-drag;
  flex: none;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 0;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.workbench-files-title-action svg {
  width: 16px;
  height: 16px;
  display: block;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: square;
  stroke-linejoin: miter;
}
.workbench-files-title-action:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--ink);
}
.workbench-files-title-action[aria-pressed='true'] svg,
.workbench-files-title-action:hover:not(:disabled) svg {
  animation: workbench-title-file-signal 1.1s steps(2, end) infinite;
  filter: drop-shadow(-1px 0 color-mix(in srgb, var(--accent) 75%, #f44))
    drop-shadow(1px 0 color-mix(in srgb, var(--accent) 70%, #4ff));
}
@keyframes workbench-title-file-signal {
  0%, 100% { transform: translate(0, 0) skewX(0deg); }
  25% { transform: translate(-1px, 0) skewX(-4deg); }
  50% { transform: translate(1px, 1px) skewX(5deg); }
  75% { transform: translate(-1px, 0) skewX(-2deg); }
}
.workbench-files-title-action:focus-visible,
.workbench-files-title-action[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
  outline-offset: 1px;
}
.workbench-files-title-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.terminal-title-connection,
.terminal-title-status,
.terminal-title-clear {
  -webkit-app-region: no-drag;
  flex: none;
  font: 12px/1.2 var(--font-mono);
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.terminal-window-frame .window-frame-signal {
  display: none;
}
.terminal-window-frame .window-frame-title-actions {
  flex: 1;
}
.cyber-window.is-terminal .cyber-window-title-actions {
  flex: 1;
}
.cyber-window.is-terminal .cyber-window-signal {
  display: none;
}
.terminal-title-connection {
  max-width: 190px;
  overflow: hidden;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
  text-overflow: ellipsis;
}
.terminal-title-status {
  color: color-mix(in srgb, var(--ink) 58%, transparent);
}
.terminal-title-status[data-status='connected'] {
  color: var(--el-color-success);
}
.terminal-title-status[data-status='connecting'] {
  color: var(--accent);
}
.terminal-title-clear {
  margin-left: auto;
  padding: 0;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  cursor: pointer;
}
.terminal-title-clear:hover,
.terminal-title-clear:focus-visible {
  color: var(--accent);
  outline: none;
}
.terminal-title-clear:focus-visible {
  text-decoration: underline;
  text-underline-offset: 3px;
}
@media (prefers-reduced-motion: reduce) {
  .workbench-files-title-action[aria-pressed='true'] svg,
  .workbench-files-title-action:hover:not(:disabled) svg {
    animation: none;
    filter: none;
  }
}
</style>
