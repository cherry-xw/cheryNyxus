<script setup lang="ts">
/**
 * Electron desktop surface 根组件（`?surface=desktop`，全工作区透明覆盖窗）。
 *
 * 组合：PetStage（透明模式）+ NyxusCore 星系 + AgentDialog 发消息浮动窗 + HistoryDrawer。
 * 「设置/工作台」等大界面不在本窗渲染——经 desktopBridge.openWindow 打开 Electron 原生独立窗承载
 * （settings 设置窗 / workbench 每预设一工作台窗）。
 * 鼠标穿透由 useDesktopPassthrough 统一管理（空区域点击直达桌面）。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import { NyxusCore } from '@/features/pets/nyxus/public'
import AgentDialog from '@/features/agent/chat/AgentDialog.vue'
import HistoryDrawer from '@/features/agent/drawer/HistoryDrawer.vue'
import { useDesktopPassthrough } from './useDesktopPassthrough'

useDesktopPassthrough()

/**
 * 透明窗禁止 `color-scheme: dark`：Element Plus dark css-vars 会在 html.dark 上设
 * color-scheme:dark，Chromium 据此给根画布（html/body 底色）绘制系统深色底——透明窗下
 * 表现为全屏灰罩（浅深色切换后尤为明显）。此处置于 light：主题 token（--ink 等）不受
 * 影响，只锁根画布底色为透明。
 */
const ROOT_COLOR_SCHEME = 'light'
let prevColorScheme = ''

onMounted(() => {
  const root = document.documentElement
  prevColorScheme = root.style.colorScheme
  root.style.colorScheme = ROOT_COLOR_SCHEME
})
onBeforeUnmount(() => {
  document.documentElement.style.colorScheme = prevColorScheme
})
</script>

<template>
  <!-- .desktop-surface-guard：本文件底部 :has() 兜底样式的锚点（透明窗根画布禁止铺底色）。 -->
  <div class="desktop-surface-guard" aria-hidden="true" style="display: none" />
  <PetStage transparent />
  <NyxusCore />
  <AgentDialog />
  <HistoryDrawer />
</template>

<style lang="less">
// desktop surface 根画布兜底：任何组件（含 EP dark css-vars）给 html/body/#app 铺底色
// 都会让透明窗出现全屏色罩。!important 压过低特异性规则；仅本 surface 挂载时存在。
html:has(.desktop-surface-guard),
html:has(.desktop-surface-guard) body,
html:has(.desktop-surface-guard) #app {
  background: transparent !important;
}
</style>
