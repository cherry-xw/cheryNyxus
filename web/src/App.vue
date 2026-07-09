<script setup lang="ts">
import { onMounted } from "vue";
import PetStage from "@/features/pets/PetStage.vue";
import AgentFab from "@/features/agent/AgentFab.vue";
import AgentDialog from "@/features/agent/AgentDialog.vue";
import HistoryDrawer from "@/features/agent/HistoryDrawer.vue";
import SessionList from "@/features/agent/SessionList.vue";
import SettingsDialog from "@/features/agent/settings/SettingsDialog.vue";
import { useConnectionStore, useAgentsStore } from "@/stores";
import { wsClient } from "@/services/ws";

onMounted(() => {
  const conn = useConnectionStore();
  const agents = useAgentsStore();

  // 订阅 chunk/notification → agents store 路由
  wsClient.onChunk((chunk) => agents.routeChunk(chunk));
  wsClient.onNotification((notif) => agents.routeNotification(notif));

  // 建连成功后拉 chat.list 重建 pet 树（store 内部幂等，断线重连后可再触发）
  let prevStatus: string | null = null;
  wsClient.onStatus((s) => {
    if (s === "connected") {
      // F5 刷新:initialized=false → initFromChats 重建 pet 树 + rebuildSpawnWaits
      // 瞬断重连:initialized=true → 仅 rebuildSpawnWaits(重建子等待 + 检测主卡死)
      if (prevStatus === "disconnected") {
        // 瞬断重连:跳过 initFromChats(已初始化),直接 rebuildSpawnWaits
        agents.rebuildSpawnWaits().catch((e) => {
          console.error("[agents] rebuildSpawnWaits 失败:", e);
        });
      } else {
        // 首次建连或 F5 后重连:initFromChats(内部会调 rebuildSpawnWaits)
        agents.initFromChats().catch((e) => {
          // 规则12 fail loud：initFromChats 失败显性化（静默吞错会导致空白难定位）
          console.error("[agents] initFromChats 失败:", e);
        });
      }
    }
    prevStatus = s;
  });

  conn.init();
});
</script>

<template>
  <PetStage />
  <AgentFab />
  <AgentDialog />
  <HistoryDrawer />
  <SessionList />
  <SettingsDialog />
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
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
</style>
