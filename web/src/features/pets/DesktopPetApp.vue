<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import NyxusParticle from './nyxus/components/NyxusParticle.vue'
import { desktopPetBridge, type DesktopPetCandidate } from './desktopPetBridge'
import type { PetAction, PetMood } from './types/types'

const bridge = desktopPetBridge()
const demoPet: DesktopPetCandidate = {
  chatId: 'desktop-preview',
  label: 'cheryNyxus',
  action: 'idle',
  mood: 'serious',
  working: false,
  speech: '',
  activity: 0,
}
const pet = ref<DesktopPetCandidate | null>(bridge ? null : demoPet)
const gestureAction = ref<PetAction | null>(null)
const gestureMood = ref<PetMood | null>(null)
const hovering = ref(false)
const action = computed(
  () => gestureAction.value ?? (hovering.value ? 'hover' : (pet.value?.action ?? 'idle')),
)
const mood = computed(() => gestureMood.value ?? pet.value?.mood ?? 'serious')

let unsubscribe: (() => void) | undefined
let down: { x: number; y: number; clientX: number; clientY: number; pointerId: number } | null =
  null
let longPress: ReturnType<typeof setTimeout> | undefined
let clickTimer: ReturnType<typeof setTimeout> | undefined
let reactionTimer: ReturnType<typeof setTimeout> | undefined
let dragging = false
let suppressClick = false
let clickCount = 0
let lastClickAt = 0

function react(nextAction: PetAction, nextMood: PetMood, duration = 900): void {
  gestureAction.value = nextAction
  gestureMood.value = nextMood
  if (reactionTimer) clearTimeout(reactionTimer)
  reactionTimer = setTimeout(() => {
    gestureAction.value = null
    gestureMood.value = null
  }, duration)
}

function startDrag(event: PointerEvent): void {
  if (!down) return
  dragging = true
  gestureAction.value = 'dragging'
  gestureMood.value = 'panicked'
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  down = {
    x: event.screenX,
    y: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
  }
  longPress = setTimeout(() => startDrag(event), 300)
}

function onPointerMove(event: PointerEvent): void {
  if (!down) return
  if (!dragging && Math.hypot(event.screenX - down.x, event.screenY - down.y) > 5) {
    if (longPress) clearTimeout(longPress)
    startDrag(event)
  }
  if (dragging) {
    bridge?.moveWindow({ x: event.screenX - down.clientX, y: event.screenY - down.clientY })
  }
}

function onPointerUp(event: PointerEvent): void {
  if (longPress) clearTimeout(longPress)
  longPress = undefined
  if (dragging) {
    suppressClick = true
    react('dropped', 'surprised', 700)
  }
  dragging = false
  down = null
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

function onClick(): void {
  if (suppressClick) {
    suppressClick = false
    return
  }
  if (dragging || !pet.value) return
  const now = performance.now()
  clickCount = now - lastClickAt < 1000 ? clickCount + 1 : 1
  lastClickAt = now
  if (clickCount >= 3) {
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = undefined
    react('clicked', 'angry', 1300)
    clickCount = 0
    return
  }
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = setTimeout(() => react('clicked', 'happy'), 240)
}

function onDoubleClick(): void {
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = undefined
  if (pet.value) bridge?.openChat(pet.value.chatId)
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  if (pet.value) bridge?.showContextMenu(pet.value.chatId)
}

function trackPassthrough(event: PointerEvent): void {
  const target = event.target as HTMLElement | null
  bridge?.setMousePassthrough(!target?.closest('.pet-hit'))
}

onMounted(() => {
  unsubscribe = bridge?.onState((next) => (pet.value = next))
  window.addEventListener('pointermove', trackPassthrough)
})
onBeforeUnmount(() => {
  unsubscribe?.()
  window.removeEventListener('pointermove', trackPassthrough)
  if (longPress) clearTimeout(longPress)
  if (clickTimer) clearTimeout(clickTimer)
  if (reactionTimer) clearTimeout(reactionTimer)
})
</script>

<template>
  <main class="desktop-pet-surface" aria-label="cheryNyxus desktop pet">
    <section
      v-if="pet"
      class="pet-hit"
      @pointerenter="hovering = true"
      @pointerleave="hovering = false"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @click="onClick"
      @dblclick="onDoubleClick"
      @contextmenu="onContextMenu"
    >
      <NyxusParticle
        :action="action"
        :mood="mood"
        :working="pet.working"
        :size="144"
        :respect-connection="false"
        boot
      />
    </section>
  </main>
</template>

<style scoped>
.desktop-pet-surface {
  width: 100vw;
  height: 100vh;
  display: grid;
  place-items: end center;
  overflow: hidden;
  background: transparent;
  user-select: none;
}
.pet-hit {
  position: relative;
  width: 156px;
  height: 184px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  cursor: grab;
  touch-action: none;
}
.pet-hit:active {
  cursor: grabbing;
}
</style>
