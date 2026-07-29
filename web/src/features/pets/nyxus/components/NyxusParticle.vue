<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '@/stores'
import {
  resolveNyxusMode,
  stepNyxusParticles,
  type NyxusCosmicMode,
  type NyxusReaction,
} from '../particles/nyxusParticleEngine'
import { createNyxusRenderer } from '../particles/nyxusRenderer'
import { useNyxusParticleInput } from '../composables/useNyxusParticleInput'
import type { PetAction, PetMood } from '@/features/pets/types/types'

const props = withDefaults(
  defineProps<{
    action?: PetAction
    mood?: PetMood
    working?: boolean
    size?: number
    reaction?: NyxusReaction | null
    boot?: boolean
    respectConnection?: boolean
    /** 中心在线状态点(仅主 pet):connected 白发光 / connecting 明灭 / disconnected 黑发光 */
    statusDot?: boolean
  }>(),
  {
    action: 'idle',
    mood: 'serious',
    working: false,
    size: 112,
    reaction: null,
    boot: false,
    respectConnection: true,
    statusDot: false,
  },
)

const connection = useConnectionStore()
const rootRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const mode = ref('idle')
const cosmicModeLabel = ref<NyxusCosmicMode | 'nebula'>('nebula')
const particleCount = computed(() => Math.round(Math.min(800, Math.max(500, props.size * 5.1))))
const canvasExtent = computed(() => Math.round(props.size * 2.35))

const renderer = createNyxusRenderer()
const inputState = useNyxusParticleInput({
  props,
  rootRef,
  canvasExtent: () => canvasExtent.value,
  particleCount: () => particleCount.value,
})

let raf = 0
let lastFrameAt = 0
let pausedByVisibility = false

function onVisibilityChange(): void {
  pausedByVisibility = document.hidden
  if (!pausedByVisibility) {
    lastFrameAt = performance.now()
    raf = requestAnimationFrame(frame)
  }
}

function frame(now: number): void {
  if (pausedByVisibility) return
  const canvas = canvasRef.value
  const context = canvas?.getContext('2d')
  if (!canvas || !context) return
  if (lastFrameAt === 0) lastFrameAt = now
  const dt = Math.min((now - lastFrameAt) / 1000, 1 / 30)
  lastFrameAt = now
  inputState.decay(dt)

  renderer.resizeCanvas(canvas, context, canvasExtent.value)
  const input = inputState.createInput(now)
  const particles = inputState.getParticles()
  stepNyxusParticles(particles, input, inputState.isReducedMotion() ? Math.min(dt, 1 / 45) : dt)
  mode.value = resolveNyxusMode(input)
  cosmicModeLabel.value = input.cosmicMode ?? 'nebula'
  renderer.render(context, particles, input, canvasExtent.value, props.statusDot, connection.status)
  raf = requestAnimationFrame(frame)
}

watch(particleCount, () => inputState.resetParticles())

onMounted(() => {
  inputState.resetParticles()
  window.addEventListener('pointermove', inputState.onPointerMove, { passive: true })
  window.addEventListener('pointerdown', inputState.onPointerDown, { passive: true })
  window.addEventListener('pointerup', inputState.onPointerUp, { passive: true })
  window.addEventListener('pointercancel', inputState.onPointerUp, { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  raf = requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('pointermove', inputState.onPointerMove)
  window.removeEventListener('pointerdown', inputState.onPointerDown)
  window.removeEventListener('pointerup', inputState.onPointerUp)
  window.removeEventListener('pointercancel', inputState.onPointerUp)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  renderer.dispose()
})
</script>

<template>
  <span
    ref="rootRef"
    class="nyxus-particle"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    aria-label="cheryNyxus particle pet"
    :data-mode="mode"
    :data-cosmic-mode="cosmicModeLabel"
    :data-particle-count="particleCount"
  >
    <canvas
      ref="canvasRef"
      :style="{
        width: `${canvasExtent}px`,
        height: `${canvasExtent}px`,
        left: `${(size - canvasExtent) / 2}px`,
        top: `${(size - canvasExtent) / 2}px`,
      }"
      aria-hidden="true"
    />
  </span>
</template>

<style scoped>
.nyxus-particle {
  position: relative;
  display: block;
  flex: 0 0 auto;
  overflow: visible;
  pointer-events: none;
  contain: layout style;
}

.nyxus-particle canvas {
  position: absolute;
  max-width: none;
  pointer-events: none;
  transform: translateZ(0);
}
</style>
