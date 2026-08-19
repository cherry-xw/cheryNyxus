<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { desktopBridge } from './desktopBridge'
import { useDesktopPassthrough } from './useDesktopPassthrough'

defineProps<{ label: string }>()

useDesktopPassthrough()

const phase = ref<'idle' | 'out' | 'in'>('idle')
const bridge = desktopBridge()
const cleanup = bridge?.onSurfaceTeleport((event) => {
  phase.value = event.phase
  window.setTimeout(() => {
    if (phase.value === event.phase) phase.value = 'idle'
  }, event.phase === 'out' ? 300 : 400)
})
onBeforeUnmount(() => cleanup?.())

const classes = computed(() => ({
  'is-teleport-out': phase.value === 'out',
  'is-teleport-in': phase.value === 'in',
}))
</script>

<template>
  <main class="floating-surface" :class="classes" :aria-label="label">
    <div class="portal" aria-hidden="true" />
    <div class="floating-content"><slot /></div>
  </main>
</template>

<style lang="less">
html:has(.floating-surface),
html:has(.floating-surface) body,
html:has(.floating-surface) #app {
  background: transparent !important;
  color-scheme: light;
}

.floating-surface {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 6px;
  overflow: hidden;
  background: transparent;
}

.floating-content {
  position: relative;
  width: 100%;
  height: 100%;
  transform-origin: 50% 50%;
}

.portal {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 10000;
  width: 78px;
  height: 24px;
  border: 2px solid rgba(129, 157, 255, 0.8);
  border-radius: 50%;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.2);
  box-shadow: 0 0 24px rgba(129, 157, 255, 0.8);
  pointer-events: none;
}

.floating-surface.is-teleport-out .floating-content {
  animation: floating-teleport-out 300ms ease-in forwards;
}
.floating-surface.is-teleport-out .portal {
  animation: floating-portal-out 300ms ease-out forwards;
}
.floating-surface.is-teleport-in .floating-content {
  animation: floating-teleport-in 400ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.floating-surface.is-teleport-in .portal {
  animation: floating-portal-in 400ms ease-out both;
}

@keyframes floating-teleport-out {
  to { opacity: 0; transform: scale(0.05); }
}
@keyframes floating-teleport-in {
  from { opacity: 0; transform: scale(0.05); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes floating-portal-out {
  40% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  to { opacity: 0; transform: translate(-50%, -50%) scale(0.45); }
}
@keyframes floating-portal-in {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.4); }
  45% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  to { opacity: 0; transform: translate(-50%, -50%) scale(0.2); }
}
</style>
