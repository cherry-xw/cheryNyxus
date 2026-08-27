<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useNyxusHost } from '../application/host'
import {
  resolveNyxusMode,
  stepNyxusParticles,
  type NyxusCosmicMode,
  type NyxusReaction,
  type NyxusNearbyPet,
} from '../particles/nyxusParticleEngine'
import { createNyxusRenderer } from '../particles/nyxusRenderer'
import { useNyxusParticleInput } from '../composables/useNyxusParticleInput'
import type { PetAction, PetMood } from '@/domain/pets/types'
import {
  particleCountForSize,
  reportDisplayFrame,
  renderQualityProfile,
  useRenderQuality,
} from '@/composables/renderQuality'
import { setPerformanceMetric } from '@/utils/performanceDiagnostics'
import { nyxusMenuOpen } from '../nyxusUiState'

const props = withDefaults(
  defineProps<{
    action?: PetAction
    mood?: PetMood
    working?: boolean
    size?: number
    reaction?: NyxusReaction | null
    interactive?: boolean
    boot?: boolean
    respectConnection?: boolean
    /** Core 提供的最近普通 Pet 视觉关联；只读且不参与运动。 */
    nearbyPet?: NyxusNearbyPet | null
    /** 中心在线状态点(仅主 pet):connected 白发光 / connecting 明灭 / disconnected 黑发光 */
    statusDot?: boolean
    /** A covering application surface is active; keep one low-cost decorative frame loop. */
    background?: boolean
  }>(),
  {
    action: 'idle',
    mood: 'serious',
    working: false,
    size: 112,
    reaction: null,
    interactive: true,
    boot: false,
    respectConnection: true,
    nearbyPet: null,
    statusDot: false,
    background: false,
  },
)

const { connection } = useNyxusHost()
const rootRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const mode = ref('idle')
const cosmicModeLabel = ref<NyxusCosmicMode | 'nebula'>('nebula')
const quality = useRenderQuality()
const effectiveTier = computed(() => (props.background ? 'low' : quality.tier.value))
const profile = computed(() => renderQualityProfile(effectiveTier.value))
const particleCount = computed(() => particleCountForSize(props.size, effectiveTier.value))
const canvasExtent = computed(() => Math.round(props.size * 2.35))

const renderer = createNyxusRenderer()
const inputState = useNyxusParticleInput({
  props,
  rootRef,
  canvasExtent: () => canvasExtent.value,
  particleCount: () => particleCount.value,
})

let raf = 0
let lastRafAt = 0
let lastRenderAt = 0
let lastAtmosphereAt = 0
let simulationAccumulator = 0
let pausedByVisibility = false
let insideViewport = true
let intersectionObserver: IntersectionObserver | undefined

const SIMULATION_STEP_SECONDS = 1 / 30

function activeFrameRate(): number {
  if (props.background) return profile.value.particleIdleFps
  const active =
    props.working ||
    (props.action !== 'idle' && props.action !== 'walk') ||
    !!props.reaction ||
    nyxusMenuOpen.value
  return active ? profile.value.particleActiveFps : profile.value.particleIdleFps
}

function pixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, profile.value.particleDpr)
}

function resumeFrameLoop(): void {
  if (pausedByVisibility || !insideViewport || raf) return
  lastRafAt = performance.now()
  raf = requestAnimationFrame(frame)
}

function onVisibilityChange(): void {
  pausedByVisibility = document.hidden
  if (!pausedByVisibility) {
    resumeFrameLoop()
  }
}

function frame(now: number): void {
  raf = 0
  if (pausedByVisibility || !insideViewport) return
  if (lastRafAt > 0) reportDisplayFrame(now - lastRafAt, now)
  lastRafAt = now
  raf = requestAnimationFrame(frame)

  const renderIntervalMs = 1000 / activeFrameRate()
  if (lastRenderAt && now - lastRenderAt < renderIntervalMs) return
  const canvas = canvasRef.value
  const context = canvas?.getContext('2d')
  if (!canvas || !context) return
  const elapsedSeconds = lastRenderAt ? Math.min((now - lastRenderAt) / 1000, 0.1) : 0
  lastRenderAt = now
  simulationAccumulator = Math.min(0.1, simulationAccumulator + elapsedSeconds)

  const ratio = pixelRatio()
  renderer.resizeCanvas(canvas, context, canvasExtent.value, ratio)
  const particles = inputState.getParticles()
  const simulationStep = inputState.isReducedMotion() ? 1 / 45 : SIMULATION_STEP_SECONDS
  let simulationSteps = 0
  while (simulationAccumulator >= simulationStep && simulationSteps < 3) {
    simulationAccumulator -= simulationStep
    simulationSteps += 1
  }
  if (simulationSteps > 0) inputState.decay(simulationSteps * simulationStep)
  const input = inputState.createInput(now)
  for (let index = 0; index < simulationSteps; index += 1) {
    stepNyxusParticles(particles, input, simulationStep)
  }
  mode.value = resolveNyxusMode(input)
  cosmicModeLabel.value = input.cosmicMode ?? 'nebula'
  const atmosphereInterval = 1000 / profile.value.particleAtmosphereFps
  const refreshAtmosphere = !lastAtmosphereAt || now - lastAtmosphereAt >= atmosphereInterval
  if (refreshAtmosphere) lastAtmosphereAt = now
  const renderStartedAt = performance.now()
  renderer.render(
    context,
    particles,
    input,
    canvasExtent.value,
    props.statusDot,
    connection.status,
    { pixelRatio: ratio, refreshAtmosphere },
  )
  setPerformanceMetric('nyxus.renderMs', performance.now() - renderStartedAt)
  setPerformanceMetric('nyxus.particleCount', particles.length)
  setPerformanceMetric('nyxus.pixelRatio', ratio)
  setPerformanceMetric('nyxus.canvasBytes', canvas.width * canvas.height * 4 * 3)
}

watch(particleCount, () => {
  inputState.resetParticles()
  lastAtmosphereAt = 0
})

onMounted(() => {
  inputState.resetParticles()
  if (props.interactive) {
    window.addEventListener('pointermove', inputState.onPointerMove, { passive: true })
    window.addEventListener('pointerdown', inputState.onPointerDown, { passive: true })
    window.addEventListener('pointerup', inputState.onPointerUp, { passive: true })
    window.addEventListener('pointercancel', inputState.onPointerUp, { passive: true })
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (typeof IntersectionObserver !== 'undefined') {
    intersectionObserver = new IntersectionObserver(([entry]) => {
      insideViewport = entry?.isIntersecting ?? true
      if (insideViewport) resumeFrameLoop()
      else if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    })
    if (rootRef.value) intersectionObserver.observe(rootRef.value)
  }
  resumeFrameLoop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (props.interactive) {
    window.removeEventListener('pointermove', inputState.onPointerMove)
    window.removeEventListener('pointerdown', inputState.onPointerDown)
    window.removeEventListener('pointerup', inputState.onPointerUp)
    window.removeEventListener('pointercancel', inputState.onPointerUp)
  }
  document.removeEventListener('visibilitychange', onVisibilityChange)
  intersectionObserver?.disconnect()
  renderer.dispose()
})
</script>

<template>
  <span
    ref="rootRef"
    class="nyxus-particle"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    aria-label="Cherry Nyxus galaxy entry"
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
