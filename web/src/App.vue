<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import DesktopSurface from '@/features/desktop/DesktopSurface.vue'
import LoginSurface from '@/features/desktop/LoginSurface.vue'
import WindowFrame from '@/features/desktop/WindowFrame.vue'
import ConnectionStatusChip from '@/features/desktop/ConnectionStatusChip.vue'
import NyxusCore from '@/features/pets/nyxus/components/NyxusCore.vue'
import AgentDialog from '@/features/agent/chat/AgentDialog.vue'
import WorkbenchDialog from '@/features/agent/dialog/WorkbenchDialog.vue'
import WorkbenchCapsule from '@/features/agent/dialog/WorkbenchCapsule.vue'
import HistoryDrawer from '@/features/agent/drawer/HistoryDrawer.vue'
import SettingsDialog from '@/features/agent/settings/SettingsDialog.vue'
import OpenConfigDirButton from '@/features/agent/settings/components/OpenConfigDirButton.vue'
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
  useInteractionsStore,
  useThemeStore,
  useAuthStore,
} from '@/stores'
import { wsClient } from '@/services/ws'

// 鉴权非强制：本地直连不鉴权；远端由 cheryNyxus 登录弹窗对接（token 存 auth store）。
// surface 分发：desktop（Electron 全工作区透明宠物窗）/ settings（Electron 原生设置窗）/
// workbench（Electron 每预设一工作台原生窗）/ undefined（浏览器完整单页）。
// 四个 Electron/浏览器面都直连 WS（后端按连接扇出）。
// 节点树工作台多窗口：浏览器面每预设一窗（windowId = presetId），由 workbenchWindowsList 驱动渲染；
// Electron workbench 面本窗 store 只含一条记录（原生窗本身即"每预设一窗"）。
const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const query = new URLSearchParams(window.location.search)
const surface = query.get('surface')
const surfacePresetId = query.get('presetId') ?? undefined
const surfaceChatId = query.get('chatId') ?? undefined
const surfaceSource = query.get('source') as 'pet' | 'history' | 'nyxus' | null
const surfaceView = query.get('view') as 'composer' | 'attention' | 'tree' | null

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
const composerChatId = computed(() => agents.activeDialogChatId)
const composerTitle = computed(() => {
  const chatId = composerChatId.value
  if (!chatId) return '发消息'
  const pet = agents.petForChat(chatId)
  if (pet?.name) return pet.name
  const summary = agents.historyList.find((item) => item.chatId === chatId)
  return summary?.preset ?? surfacePresetId ?? '发消息'
})
const composerAttentionActive = computed(() => agentDialogRef.value?.isAttentionView() ?? false)
const composerAttentionCount = computed(() => agentDialogRef.value?.getWorkspaceAttentionCount() ?? 0)
/** composer 窗内按需水合会话树（与 PetStage 点击路径同语义；desktop 面不再负责）。 */
function hydrateComposerChat(chatId: string): void {
  void chatSessions.hydrateTree(chatId).catch((e) =>
    console.warn(`[App] hydrateTree ${chatId} 失败:`, e),
  )
}

if (surface === 'composer' && surfaceChatId) {
  agents.activeDialogChatId = surfaceChatId
  agents.activeDialogSource = surfaceSource ?? 'history'
  agents.activeDialogView = surfaceView ?? 'composer'
  hydrateComposerChat(surfaceChatId)
}
if (surface === 'history' && surfaceChatId) agents.openHistoryRoot(surfaceChatId)

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
  electronBridgeCleanup.push(bridge.onAuthChanged(() => {
    useAuthStore().reloadFromStorage()
    void useConnectionStore().reconnect()
  }))
  applyWindowBackground()
}

if (surface === 'composer' || surface === 'history') {
  const bridge = desktopBridge()
  if (bridge) {
    workbenchBridgeCleanup.push(bridge.onSurfaceRetarget((target) => {
      if (surface === 'composer') {
        agents.activeDialogChatId = target.chatId
        agents.activeDialogSource = target.source ?? 'history'
        agents.activeDialogView = target.view ?? 'composer'
        hydrateComposerChat(target.chatId)
      } else {
        agents.openHistoryRoot(target.chatId)
      }
    }))
  }
}

if (surface === 'history') {
  let historyOpened = !!surfaceChatId
  workbenchBridgeCleanup.push(watch(
    () => agents.historyDrawerStack.length,
    (length) => {
      if (length > 0) historyOpened = true
      else if (historyOpened) desktopBridge()?.windowControl('close')
    },
  ))
}

// workbench 面：注册必须在渲染前同步完成（WorkbenchDialog setup 读 store 的 win.value）。
if (surface === 'workbench' && surfacePresetId) {
  const wbId = agents.openWorkbenchWindow(surfacePresetId)
  // 与入口语义一致：仅新建窗口恢复会话（chatId 为空时才设置），重开复用不覆盖浏览
  if (surfaceChatId && !agents.workbenchWindows[wbId]?.chatId) {
    agents.setWorkbenchWindowChat(wbId, surfaceChatId)
  }
  const bridge = desktopBridge()
  if (bridge) {
    // main 下发「打开节点树」定位 / 会话切换 → 写本窗 store
    workbenchBridgeCleanup.push(
      bridge.onWorkbenchFocus((focus) => agents.setWorkbenchWindowFocus(wbId, focus)),
    )
    workbenchBridgeCleanup.push(bridge.onOpenChat((chatId) => agents.setWorkbenchWindowChat(wbId, chatId)))
    // attentionBlink（Phase E 审批/提问闪烁）→ 原生任务栏闪烁
    workbenchBridgeCleanup.push(
      watch(
        () => agents.workbenchWindows[wbId]?.attentionBlink,
        (blink) => bridge.flashFrame(!!blink),
      ),
    )
  }
}

// workbench 面标题显示名 = 预设名（windowId = presetId = config.presets 键）；外层 WindowFrame 承载。
const wbRef = ref<{ closeWorkbench: () => void } | null>(null)
/** Phase E 闪烁回推：本窗 attentionBlink → WindowFrame 标题栏暖橙外发光（任务栏闪烁已在注册块处理）。 */
const surfaceWindowBlink = computed(
  () => (surfacePresetId ? agents.workbenchWindows[surfacePresetId]?.attentionBlink : false) ?? false,
)
/** 点击 WindowFrame 标题栏视为用户已注意到该窗口 → 熄灭闪烁（与浏览器路径 onTitlePointerDown 同语义）。 */
function onWorkbenchTitlePointerDown(): void {
  if (surfacePresetId) agents.setWorkbenchWindowBlink(surfacePresetId, false)
}
/** 标题栏「打开配置文件夹」失败：标题栏入口独立于 SettingsDialog 内部错误弹窗，用轻量消息提示。 */
function onSettingsOpenDirError(message: string): void {
  ElMessage.error(message)
}

onMounted(() => {
  bindElectronThemeBridge()
  void bootstrap()
})
onBeforeUnmount(() => {
  electronBridgeCleanup.splice(0).forEach((cleanup) => cleanup())
  workbenchBridgeCleanup.splice(0).forEach((cleanup) => cleanup())
})

async function bootstrap(): Promise<void> {
  const conn = useConnectionStore()
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  const interactions = useInteractionsStore()
  chatSessions.bindWsClient()
  // #9 接线：chatSessions 副作用 → agents pet 变更。
  // V2 发送经 chatSessions（openSession+submitInput），pet 视觉（setWorking/role_created）
  // 不再由 agents.store 驱动 → 经 effect 注入为唯一来源。
  chatSessions.bindEffects({
    onWorkingChange: agents.setWorkingForChat,
    onRoleDestroyed: (chatId) => agents.removePetsOnly([chatId]),
  })

  // 会话树是子 pet 身份的唯一权威源。无论来自 live role_created、快照还是
  // 重连回放，catalog 一变化就幂等补建舞台视觉，避免把某条瞬时通知当唯一来源。
  watch(
    () =>
      Object.values(chatSessions.sessionsById).map((session) =>
        [
          session.chatId,
          session.meta.parentChatId,
          session.meta.agentType,
          session.meta.avatar,
          session.meta.finished,
          session.run.status,
        ].join('|'),
      ),
    () => agents.reconcilePetsFromSessions(chatSessions.sessionsById),
    { immediate: true },
  )

  // 订阅 chunk/notification → agents store 路由
  wsClient.onChunk((chunk) => agents.routeChunk(chunk))
  wsClient.onNotification((notif) => {
    const event = notif as { background?: boolean; type?: string; chatId?: string } | null
    if (event?.type === 'interaction.changed') {
      void interactions.refresh().catch((cause) =>
        console.warn('[App] refresh interactions failed:', cause),
      )
    }
    if (event?.background) {
      // 后台控制面事件不进入流式 reducer：只刷新轻量会话目录。用户点 Pet/琴键后，
      // 再由 chat.open 获取完整审批参数或问题批次。
      void agents.fetchHistoryList().catch((cause) =>
        console.warn('[App] refresh background attention failed:', cause),
      )
      return
    }
    agents.routeNotification(notif)
    if (
      event?.type &&
      ['interrupt', 'accept', 'rejected', 'question_batch_requested', 'question_batch_completed'].includes(
        event.type,
      )
    ) {
      void interactions.refresh().catch((cause) =>
        console.warn('[App] refresh interactions failed:', cause),
      )
      void agents.fetchHistoryList().catch((cause) =>
        console.warn('[App] refresh foreground attention failed:', cause),
      )
    }
  })

  // 建连成功后拉 chat.list 重建 pet 树（store 内部幂等，断线重连后可再触发）
  let prevStatus: string | null = null
  wsClient.onStatus((s) => {
    if (s === 'connected') {
      void interactions.refresh().catch((e) => console.warn('[interactions] refresh 失败:', e))
      // F5 刷新:initialized=false → initFromChats 重建 pet 树 + rebuildSpawnWaits
      // 瞬断重连:initialized=true → 仅 rebuildSpawnWaits(重建子等待 + 检测主卡死)
      if (prevStatus === 'disconnected') {
        // 瞬断重连:跳过 initFromChats(已初始化),直接 rebuildSpawnWaits
        // 先按 seq 补增量；保留期外才由 store 自动 chat.get 重拉快照。
        agents.markAllStreamsDirty()
        agents
          .syncChatEvents()
          .then(() => agents.rebuildSpawnWaits())
          .catch((e) => {
            console.error('[agents] rebuildSpawnWaits 失败:', e)
          })
        // ChatSession 层：仅重连已 hydrated 且 running 的 session（attach->sync(lastSeq)）
        chatSessions.reconnect().catch((e) => console.warn('[chatSessions] reconnect 失败:', e))
      } else {
        // 首次建连或 F5 后重连:initFromChats(内部会调 rebuildSpawnWaits)
        agents.initFromChats().catch((e) => {
          // 规则12 fail loud：initFromChats 失败显性化（静默吞错会导致空白难定位）
          console.error('[agents] initFromChats 失败:', e)
        })
        // ChatSession 层：catalog + top-5 root 后代完整 hydration（attach->sync 内核）
        chatSessions.startup().catch((e) => console.warn('[chatSessions] startup 失败:', e))
      }
    }
    prevStatus = s
  })

  conn.init()
}
</script>

<template>
  <DesktopSurface v-if="surface === 'desktop'" />
  <!-- composer 原生窗：复用 WindowFrame 公共外壳（与 settings/workbench 统一），标题靠左显示 pet 名，
       能力按钮经 title-actions slot 放标题后（紧贴标题），三键保持最右；AgentDialog native 隐藏自绘标题栏 -->
  <WindowFrame
    v-else-if="surface === 'composer'"
    :title="composerTitle"
  >
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
          :class="{ 'is-active': composerAttentionActive }"
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
    <SettingsDialog native />
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
    <AgentDialog />
    <WorkbenchDialog
      v-for="win in agents.workbenchWindowsList"
      :key="win.id"
      :window-id="win.id"
      :preset-id="win.presetId"
    />
    <template v-for="win in agents.workbenchWindowsList" :key="`capsule-${win.id}`">
      <WorkbenchCapsule v-if="win.minimized" :window-id="win.id" />
    </template>
    <HistoryDrawer />
    <SettingsDialog />
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
</style>
