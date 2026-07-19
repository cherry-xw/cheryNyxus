<script setup lang="ts">
import { onMounted, provide, ref } from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import AgentFab from '@/features/agent/AgentFab.vue'
import AgentDialog from '@/features/agent/AgentDialog.vue'
import HistoryDrawer from '@/features/agent/HistoryDrawer.vue'
import SessionList from '@/features/agent/SessionList.vue'
import SettingsDialog from '@/features/agent/settings/SettingsDialog.vue'
import {
  createHistoryDrawerManager,
  HISTORY_DRAWER_MANAGER_KEY,
} from '@/features/agent/useHistoryDrawerManager'
import { useConnectionStore, useAgentsStore } from '@/stores'
import { wsClient } from '@/services/ws'
import { httpUrl } from '@/services/http'

const authChecked = ref(false)
const authenticated = ref(false)

// 历史抽屉跨层管理层：顶层 provide，供 SpawnRenderer「详情」/ HistoryDrawer / panel inject（不耦合 store 数据层）
provide(HISTORY_DRAWER_MANAGER_KEY, createHistoryDrawerManager())

function startLogin(): void {
  window.location.assign(
    httpUrl(`/api/auth/login?returnTo=${encodeURIComponent(window.location.pathname || '/')}`),
  )
}

onMounted(() => {
  void bootstrap()
})

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
      } else {
        // 首次建连或 F5 后重连:initFromChats(内部会调 rebuildSpawnWaits)
        agents.initFromChats().catch((e) => {
          // 规则12 fail loud：initFromChats 失败显性化（静默吞错会导致空白难定位）
          console.error('[agents] initFromChats 失败:', e)
        })
      }
    }
    prevStatus = s
  })

  conn.init()
}
</script>

<template>
  <template v-if="authenticated">
    <PetStage />
    <AgentFab />
    <AgentDialog />
    <HistoryDrawer />
    <SessionList />
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
