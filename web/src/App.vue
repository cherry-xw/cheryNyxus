<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import DesktopPetApp from '@/features/pets/DesktopPetApp.vue'
import { desktopPetBridge } from '@/features/pets/desktopPetBridge'
import NyxusCore from '@/features/pets/nyxus/components/NyxusCore.vue'
import AgentDialog from '@/features/agent/chat/AgentDialog.vue'
import HistoryDrawer from '@/features/agent/drawer/HistoryDrawer.vue'
import SessionList from '@/features/agent/drawer/SessionList.vue'
import NyxusHistoryPanel from '@/features/pets/nyxus/components/NyxusHistoryPanel.vue'
import SettingsDialog from '@/features/agent/settings/SettingsDialog.vue'
import {
  createHistoryDrawerManager,
  HISTORY_DRAWER_MANAGER_KEY,
} from '@/features/agent/drawer/useHistoryDrawerManager'
import { useConnectionStore, useAgentsStore, useChatSessionsStore } from '@/stores'
import { wsClient } from '@/services/ws'
import { httpUrl } from '@/services/http'
import { selectNyxusSession } from '@/stores/chats/selectors'

const authChecked = ref(false)
const authenticated = ref(false)
const isDesktopPetSurface =
  new URLSearchParams(window.location.search).get('surface') === 'desktop-pet'
const cleanupDesktopBridge: Array<() => void> = []

// 历史抽屉跨层管理层：顶层 provide，供 SpawnRenderer「详情」/ HistoryDrawer / panel inject（不耦合 store 数据层）
provide(HISTORY_DRAWER_MANAGER_KEY, createHistoryDrawerManager())

function startLogin(): void {
  window.location.assign(
    httpUrl(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname || '/')}`),
  )
}

onMounted(() => {
  if (!isDesktopPetSurface) void bootstrap()
})
onBeforeUnmount(() => cleanupDesktopBridge.splice(0).forEach((cleanup) => cleanup()))

async function bootstrap(): Promise<void> {
  try {
    const response = await fetch(httpUrl('/api/auth/me'), { credentials: 'same-origin' })
    const data = (await response.json()) as { authenticated?: boolean }
    authenticated.value = response.ok && data.authenticated === true
  } catch {
    authenticated.value = false
  } finally {
    authChecked.value = true
  }
  if (!authenticated.value) return

  const conn = useConnectionStore()
  const agents = useAgentsStore()
  const chatSessions = useChatSessionsStore()
  const petBridge = desktopPetBridge()
  if (petBridge) {
    // nyxus 桌面窗口数据源：chatSessions 的 nyxus session（root + preset=cheryNyxus），不经 PetInstance
    cleanupDesktopBridge.push(
      watch(
        () => selectNyxusSession(chatSessions.sessionsById, agents.activeNyxusChatId) ?? null,
        (session) => {
          if (!session) {
            petBridge.publish([])
            return
          }
          petBridge.publish([
            {
              chatId: session.chatId,
              label: session.meta.workspace?.split(/[\\/]/).filter(Boolean).pop() ?? 'cheryNyxus',
              action: session.run.status === 'running' ? 'chatting' : 'idle',
              mood: 'serious',
              working: session.run.status === 'running',
              speech: '',
              activity:
                session.run.status === 'running' ? Date.now() : (session.meta.updatedAt ?? 0),
            },
          ])
        },
        { immediate: true },
      ),
    )
    cleanupDesktopBridge.push(
      petBridge.onOpenChat((chatId) => {
        if (chatSessions.sessionsById[chatId]) agents.activeDialogChatId = chatId
      }),
    )
    cleanupDesktopBridge.push(
      petBridge.onOpenHistory((chatId) => {
        if (chatSessions.sessionsById[chatId]) agents.openHistoryRoot(chatId)
      }),
    )
  }
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
  wsClient.onNotification((notif) => agents.routeNotification(notif))

  // 建连成功后拉 chat.list 重建 pet 树（store 内部幂等，断线重连后可再触发）
  let prevStatus: string | null = null
  wsClient.onStatus((s) => {
    if (s === 'connected') {
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
  <DesktopPetApp v-if="isDesktopPetSurface" />
  <template v-else-if="authenticated">
    <PetStage />
    <NyxusCore />
    <AgentDialog />
    <HistoryDrawer />
    <SessionList />
    <NyxusHistoryPanel />
    <SettingsDialog />
  </template>
  <div
    v-else-if="authChecked"
    class="login-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="登录"
  >
    <section class="login-card">
      <h1>需要管理员登录</h1>
      <p>设置和控制功能已锁定。只有身份提供商中配置为 admin 的账号可以进入。</p>
      <button type="button" @click="startLogin">使用 OAuth2 登录</button>
    </section>
  </div>
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

.login-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(15, 17, 22, 0.72);
  backdrop-filter: blur(5px);
}

.login-card {
  width: min(400px, 100%);
  padding: 30px;
  border-radius: 16px;
  color: #f7f5ef;
  background: #20242d;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);

  h1 {
    margin: 0 0 12px;
    font-size: 22px;
  }
  p {
    margin: 0 0 24px;
    line-height: 1.6;
    color: #c6c9d0;
  }
  button {
    width: 100%;
    border: 0;
    border-radius: 8px;
    padding: 11px 16px;
    color: white;
    background: #5376d4;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
}
</style>
