<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import NyxusParticle from './nyxus/components/NyxusParticle.vue'
import { desktopPetBridge, type DesktopPetCandidate } from './desktopPetBridge'

const bridge = desktopPetBridge()
const previewEntry: DesktopPetCandidate = {
  chatId: 'desktop-preview',
  label: 'Cherry Nyxus',
  working: false,
}
const entry = ref<DesktopPetCandidate | null>(bridge ? null : previewEntry)
let unsubscribe: (() => void) | undefined

function openNyxus(): void {
  if (entry.value) bridge?.openChat(entry.value.chatId)
}

function trackPassthrough(event: PointerEvent): void {
  const target = event.target as HTMLElement | null
  bridge?.setMousePassthrough(!target?.closest('.nyxus-entry-hit'))
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
  <main class="desktop-nyxus-surface" aria-label="Cherry Nyxus desktop entry">
    <button
      v-if="entry"
      type="button"
      class="nyxus-entry-hit"
      aria-label="打开 Cherry Nyxus"
      @click="openNyxus"
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
.desktop-nyxus-surface {
  width: 100vw;
  height: 100vh;
  display: grid;
  place-items: end center;
  overflow: hidden;
  background: transparent;
  user-select: none;
}

.nyxus-entry-hit {
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
