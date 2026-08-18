<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, watch } from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import DesktopSurface from '@/features/desktop/DesktopSurface.vue'
import ConsoleShell from '@/features/desktop/ConsoleShell.vue'
import NyxusCore from '@/features/pets/nyxus/components/NyxusCore.vue'
import AgentDialog from '@/features/agent/chat/AgentDialog.vue'
import WorkbenchDialog from '@/features/agent/dialog/WorkbenchDialog.vue'
import WorkbenchCapsule from '@/features/agent/dialog/WorkbenchCapsule.vue'
import HistoryDrawer from '@/features/agent/drawer/HistoryDrawer.vue'
import SettingsDialog from '@/features/agent/settings/SettingsDialog.vue'
import { desktopBridge, type ConsoleTarget } from '@/features/desktop/desktopBridge'
import {
  createHistoryDrawerManager,
  HISTORY_DRAWER_MANAGER_KEY,
} from '@/features/agent/drawer/useHistoryDrawerManager'
import { useConnectionStore, useAgentsStore, useChatSessionsStore, useInteractionsStore } from '@/stores'
import { wsClient } from '@/services/ws'

// 鉴权非强制：本地直连不鉴权；远端由 cheryNyxus 登录弹窗对接（token 存 auth store）。
// 三 surface：desktop（Electron 全工作区透明宠物窗）/ console（Electron 惰性 frameless
// 控制台窗，ConsoleShell 自绘标题栏）/ undefined（浏览器完整单页）。两个 Electron surface
// 都直连 WS（后端按连接扇出），
// 节点树工作台多窗口：每预设一窗（windowId = presetId），由 workbenchWindowsList 驱动渲染。
const agents = useAgentsStore()
const surface = new URLSearchParams(window.location.search).get('surface')
/** console surface 的 bridge 导航清理函数（非 console surface 为空）。 */
const consoleCleanup: Array<() => void> = []

// 历史抽屉跨层管理层：顶层 provide，供 SpawnRenderer「详情」/ HistoryDrawer / panel inject（不耦合 store 数据层）
provide(HISTORY_DRAWER_MANAGER_KEY, createHistoryDrawerManager())

onMounted(() => {
  bindConsoleNavigation()
  void bootstrap()
})
onBeforeUnmount(() => consoleCleanup.splice(0).forEach((cleanup) => cleanup()))

/** console surface：消费 main 转发的导航目标（desktop 窗工具环 / 托盘触发）。 */
function bindConsoleNavigation(): void {
  if (surface !== 'console') return
  const bridge = desktopBridge()
  if (!bridge) return
  consoleCleanup.push(
    bridge.onConsoleNavigate((target: ConsoleTarget) => {
      if (target.target === 'settings') {
        // console 窗 hide 不销毁，工作台窗口状态跨开关存活：打开设置时收起全部工作台，
        // 避免上次会话遗留的工作台残留在设置面板后面（收起为胶囊，可随时还原）。
        for (const win of agents.workbenchWindowsList) {
          agents.setWorkbenchWindowMinimized(win.id, true)
        }
        agents.settingsOpen = true
        return
      }
      if (target.target === 'workbench') {
        const id = agents.openWorkbenchWindow(target.presetId)
        // 与 NyxusCore.openWorkbench 语义一致：仅新建窗口恢复会话，已存在窗口不覆盖浏览
        if (target.chatId && !agents.workbenchWindows[id]?.chatId) {
          agents.setWorkbenchWindowChat(id, target.chatId)
        }
        return
      }
      if (target.target === 'history') {
        agents.activeDialogSource = 'history'
        agents.activeDialogChatId = target.chatId
      }
      // 'show'：仅显示控制台，无导航
    }),
  )
}

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
  <ConsoleShell v-else-if="surface === 'console'">
    <SettingsDialog />
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
  </ConsoleShell>
  <template v-else>
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

</style>
