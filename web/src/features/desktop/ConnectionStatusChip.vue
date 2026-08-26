<script setup lang="ts">
/**
 * ConnectionStatusChip：标题栏常驻 WS 连接状态 chip。
 * 零 props——自取 useConnectionStore；绿点已连接 / 黄点呼吸连接中 / 红点未连接。
 * 使用方：workbench 面（App.vue WindowFrame title-actions）与浏览器面 WorkbenchDialog 自绘 titlebar。
 * 仅作状态展示；断连遮罩与重试由 WorkbenchDialog 负责（connecting 不遮罩，避免启动闪遮罩）。
 */
import { computed } from 'vue'
import { useConnectionStore } from '@/application/public'

const connection = useConnectionStore()

const state = computed(() => {
  if (connection.status === 'connected') return { cls: 'is-connected', label: '已连接' }
  if (connection.status === 'connecting') return { cls: 'is-connecting', label: '连接中' }
  return { cls: 'is-disconnected', label: '未连接' }
})
</script>

<template>
  <span class="conn-chip" :class="state.cls" role="status" aria-live="polite">
    <span class="conn-dot" aria-hidden="true" />
    <span class="conn-label">{{ state.label }}</span>
  </span>
</template>

<style scoped lang="less">
.conn-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 999px;
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  background: var(--surface-soft);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  user-select: none;
}
.conn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.conn-chip.is-connected .conn-dot {
  background: #16a34a;
  box-shadow: 0 0 4px rgba(22, 163, 74, 0.55);
}
.conn-chip.is-connecting .conn-dot {
  background: #d97706;
  animation: conn-dot-pulse 1s ease-in-out infinite;
}
.conn-chip.is-disconnected {
  color: color-mix(in srgb, #dc2626 78%, var(--ink) 22%);
}
.conn-chip.is-disconnected .conn-dot {
  background: #dc2626;
}
@keyframes conn-dot-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
</style>
