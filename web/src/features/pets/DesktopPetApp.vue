<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import NyxusParticle from './nyxus/components/NyxusParticle.vue'
import { desktopPetBridge, type DesktopPetCandidate } from './desktopPetBridge'

const bridge = desktopPetBridge()
const previewEntry: DesktopPetCandidate = {
  chatId: 'desktop-preview',
  label: 'Cherry Nexus',
  working: false,
}
const entry = ref<DesktopPetCandidate | null>(bridge ? null : previewEntry)
let unsubscribe: (() => void) | undefined

function openNexus(): void {
  if (entry.value) bridge?.openChat(entry.value.chatId)
}

function trackPassthrough(event: PointerEvent): void {
  const target = event.target as HTMLElement | null
  bridge?.setMousePassthrough(!target?.closest('.nexus-entry-hit'))
}

onMounted(() => {
  unsubscribe = bridge?.onState((next) => (entry.value = next))
  window.addEventListener('pointermove', trackPassthrough)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  window.removeEventListener('pointermove', trackPassthrough)
})
</script>

<template>
  <main class="desktop-nexus-surface" aria-label="Cherry Nexus desktop entry">
    <button
      v-if="entry"
      type="button"
      class="nexus-entry-hit"
      aria-label="打开 Cherry Nexus"
      @click="openNexus"
    >
      <NyxusParticle
        :working="entry.working"
        :size="144"
        :interactive="false"
        :respect-connection="false"
        boot
      />
    </button>
  </main>
</template>

<style scoped>
.desktop-nexus-surface {
  width: 100vw;
  height: 100vh;
  display: grid;
  place-items: end center;
  overflow: hidden;
  background: transparent;
  user-select: none;
}

.nexus-entry-hit {
  width: 156px;
  height: 184px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
}
</style>
