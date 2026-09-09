<script setup lang="ts">
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="workbench-offline-mask" role="alert">
    <div class="offline-panel">
      <strong>未连接到服务器</strong>
      <span>部分功能不可用，正在自动重连…</span>
      <button type="button" class="offline-retry" @click="emit('retry')">立即重试</button>
    </div>
  </div>
</template>

<style scoped lang="less">
.workbench-offline-mask {
  position: absolute;
  z-index: var(--nx-z-connection-mask);
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--nx-bg) 72%, transparent);
  backdrop-filter: blur(6px);
}
.offline-panel {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 22px 34px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  color: var(--nx-text);
  background: color-mix(in srgb, var(--nx-bg) 92%, var(--nx-text) 8%);
  font-size: 12px;
  font-weight: 400;
  strong {
    font-size: 13px;
    font-weight: 600;
  }
}
.offline-retry {
  margin-top: 6px;
  padding: 5px 14px;
  border: 1px solid color-mix(in srgb, var(--nx-cyan) 38%, transparent);
  border-radius: 0;
  color: var(--nx-cyan);
  background: color-mix(in srgb, var(--nx-cyan) 10%, transparent);
  font: inherit;
  cursor: pointer;
  &:hover {
    background: color-mix(in srgb, var(--nx-cyan) 18%, transparent);
  }
  &:focus-visible {
    outline: 2px solid var(--nx-cyan);
    outline-offset: 2px;
  }
}
</style>
