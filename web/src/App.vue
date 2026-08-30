<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  watch,
} from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import NyxusCore from '@/features/pets/nyxus/components/NyxusCore.vue'
import { useLiteViewToggle } from '@/features/agent/workbench/useLiteViewToggle'
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
import { installPerformanceDiagnostics } from '@/utils/performanceDiagnostics'

// Electron 的每种 surface 与浏览器 overlay 互斥。重界面按实际状态下载，避免冷启动时
// 同时解析设置、历史、会话和 Pixi 工作台，并确保关闭后组件实例及其图形资源可回收。
const DesktopSurface = defineAsyncComponent(() => import('@/features/desktop/DesktopSurface.vue'))
const LoginSurface = defineAsyncComponent(() => import('@/features/desktop/LoginSurface.vue'))
const WindowFrame = defineAsyncComponent(() => import('@/features/desktop/WindowFrame.vue'))
const ConnectionStatusChip = defineAsyncComponent(
  () => import('@/features/desktop/ConnectionStatusChip.vue'),
)
const AgentDialog = defineAsyncComponent(() => import('@/features/agent/chat/AgentDialog.vue'))
const WorkbenchDialog = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchDialog.vue'),
)
const WorkbenchCapsule = defineAsyncComponent(
  () => import('@/features/agent/workbench/WorkbenchCapsule.vue'),
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
const surfaceChatId = query.get('chatId') ?? undefined
const surfaceSettingsSection = query.get('settingsSection') as
  'provider' | 'runtime' | 'limits' | null
const surfaceSource = query.get('source') as 'pet' | 'history' | 'nyxus' | null
const surfaceView = query.get('view') as 'composer' | 'attention' | 'tree' | null

/** workbench 原生窗 lite 极简视图切换（§2.1）：标题栏 ⚡ 与 WorkbenchDialog 共享 useLiteViewToggle，
 * 保证 Electron 面（surface=workbench）与浏览器面状态一致。非 workbench 面 windowId 兜底无害。
 * 顶层解构为 ref 变量以便模板自动 unwrap（对象属性访问不自动 unwrap）。 */
const { liteViewEnabled: workbenchLiteEnabled, toggleLiteView: toggleWorkbenchLiteView } =
  useLiteViewToggle(surfacePresetId ?? 'workbench')

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
      bridge.onWorkbenchFocus((focus) => workspace.setWorkbenchWindowFocus(wbId, focus)),
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

// workbench 面标题显示名 = 预设名（windowId = presetId = config.presets 键）；外层 WindowFrame 承载。
const wbRef = ref<{ closeWorkbench: () => void } | null>(null)
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
  <LoginSurface v-else-if="surface === 'login'" />
  <WindowFrame v-else-if="surface === 'settings'" title="设置">
    <!-- 标题位置扩展点：title-actions slot（标题右侧、三键左侧）——settings 面放「打开配置文件夹」 -->
    <template #title-actions>
      <OpenConfigDirButton @error="onSettingsOpenDirError" />
    </template>
    <SettingsDialog native :initial-section="surfaceSettingsSection ?? undefined" />
  </WindowFrame>
  <!-- workbench 面同用 WindowFrame 公共外壳：标题=预设名，attentionBlink→标题栏闪烁，
       关闭经 closeWorkbench（先释放根时间线订阅再交 main hide 保活）；
       title-actions 放常驻连接状态 chip（断连遮罩由 WorkbenchDialog 内部渲染） -->
  <WindowFrame
    v-else-if="surface === 'workbench'"
    :title="surfacePresetId ?? '节点树工作台'"
    :attention="surfaceWindowBlink"
    :close="() => wbRef?.closeWorkbench()"
    :title-pointer-down="onWorkbenchTitlePointerDown"
  >
    <template #title-actions>
      <ConnectionStatusChip />
      <!-- lite 极简视图切换（§2.1）：native 面 WorkbenchDialog 内部 titlebar 被 v-if="!isNative"
           隐藏，切换入口放 WindowFrame title-actions，与 WorkbenchDialog 共享 useLiteViewToggle；
           v1.0 改 el-switch（原 ⚡ 按钮 icon 歪斜、active 不突出） -->
      <el-switch
        :model-value="workbenchLiteEnabled"
        class="workbench-lite-switch"
        aria-label="切换极简 lite 视图"
        title="切换极简 lite 视图"
        @change="toggleWorkbenchLiteView"
      />
    </template>
    <WorkbenchDialog
      ref="wbRef"
      :window-id="surfacePresetId!"
      :preset-id="surfacePresetId!"
      native
    />
    <HistoryDrawer />
  </WindowFrame>
  <template v-else>
    <!-- 浏览器完整单页（不受 Electron 迁移影响）：应用内多工作台窗 + 胶囊 + overlay 设置 + 抽屉 -->
    <PetStage />
    <NyxusCore />
    <AgentDialog v-if="workspace.activeDialogChatId" />
    <WorkbenchDialog
      v-for="win in workspace.workbenchWindowsList"
      :key="win.id"
      :window-id="win.id"
      :preset-id="win.presetId"
    />
    <template v-for="win in workspace.workbenchWindowsList" :key="`capsule-${win.id}`">
      <WorkbenchCapsule v-if="win.minimized" :window-id="win.id" />
    </template>
    <HistoryDrawer v-if="workspace.historyDrawerStack.length > 0" />
    <SettingsDialog v-if="workspace.settingsOpen" />
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
  border-color: #7c3aed;
  color: #6d28d9;
  background: rgba(124, 58, 237, 0.1);
}
.composer-title-attention b {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: #dc2626;
  color: #fff;
  font-size: 8px;
  line-height: 14px;
}
// 有待处理交互时充能高亮：accent 金底白字 + 徽标脉动光晕（与 accept 按钮金底同风格，突出入口）。
// has-attention 声明在 is-active 之后 → 有待处理时金底优先于紫色选中态，避免两色叠加混淆。
.composer-title-attention.has-attention {
  border-color: #d88a26;
  background: #d88a26;
  color: #fff;
  box-shadow: 0 1px 6px color-mix(in srgb, #d88a26 55%, transparent);

  &:hover {
    background: #c97b1f;
    color: #fff;
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
    box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5);
    transform: scale(1);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(220, 38, 38, 0);
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
</style>
