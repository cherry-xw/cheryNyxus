/**
 * Nyxus 粒子输入派生（从 NyxusParticle.vue 提纯）。
 *
 * 持有 pointer 跟踪 / cosmic 形态调度 / action 同步 / release 惯性等帧间可变态，
 * 每帧产出 NyxusParticleInput 供 physics + renderer 消费。
 * 不持有 RAF 循环与 canvas（归 NyxusParticle.vue 宿主）。零行为变更。
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import { useConnectionStore } from '@/stores'
import {
  cosmicModeDuration,
  createNyxusParticles,
  kickNyxusParticles,
  type NyxusCosmicMode,
  type NyxusParticle,
  type NyxusParticleInput,
  type NyxusReaction,
  type Vec2,
} from '../particles/nyxusParticleEngine'
import {
  nyxusHighlightedTool,
  nyxusMenuOpen,
  nyxusMenuTargets,
  type NyxusMenuTool,
} from '../nyxusUiState'
import type { PetAction, PetMood } from '@/features/pets/types/types'

export interface NyxusInputProps {
  action: PetAction
  mood: PetMood
  working: boolean
  size: number
  reaction: NyxusReaction | null
  boot: boolean
  respectConnection: boolean
}

const COSMIC_MODES: readonly NyxusCosmicMode[] = [
  'blackHole',
  'pulsar',
  'binary',
  'supernova',
  'tidalRings',
]
const MENU_TOOL_ORDER: readonly NyxusMenuTool[] = ['create', 'chat', 'history', 'settings']

export function useNyxusParticleInput(opts: {
  props: NyxusInputProps
  rootRef: Ref<HTMLElement | null>
  canvasExtent: () => number
  particleCount: () => number
}) {
  const { props, rootRef, canvasExtent, particleCount } = opts
  const connection = useConnectionStore()

  let particles: NyxusParticle[] = []
  let mountedAt = 0
  let actionStartedAt = 0
  let lastActionKey = ''
  let previousAction: PetAction = props.action
  let releaseStartedAt = Number.NEGATIVE_INFINITY
  let releaseVelocityX = 0
  let releaseVelocityY = 0
  let pointerDown = false
  let pointerClientX = Number.NaN
  let pointerClientY = Number.NaN
  let pointerVelocityX = 0
  let pointerVelocityY = 0
  let pointerSpeed = 0
  let lastPointerAt = 0
  let lastPointerMoveAt = 0
  let swipeStrength = 0
  let activeCosmicMode: NyxusCosmicMode | null = null
  let cosmicModeStartedAt = 0
  let nextCosmicModeAt = 0
  let previousCosmicMode: NyxusCosmicMode | null = null
  let reducedMotion = false
  let reducedMotionQuery: MediaQueryList | undefined

  function randomCosmicModeDelay(): number {
    // 自动形态之间也至少留出半分钟星云态，避免连续频繁换形。
    const base = 30000 + Math.random() * 30000
    return reducedMotion ? base * 2.2 : base
  }

  function resetParticles(): void {
    particles = createNyxusParticles(particleCount())
  }

  function pointInsideRoot(clientX: number, clientY: number): boolean {
    const rect = rootRef.value?.getBoundingClientRect()
    if (!rect) return false
    return (
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    )
  }

  function onPointerMove(event: PointerEvent): void {
    const now = performance.now()
    if (lastPointerMoveAt > 0) {
      const dt = Math.max(8, now - lastPointerMoveAt) / 1000
      pointerVelocityX = (event.clientX - pointerClientX) / dt
      pointerVelocityY = (event.clientY - pointerClientY) / dt
      pointerSpeed = Math.hypot(pointerVelocityX, pointerVelocityY)
    }
    pointerClientX = event.clientX
    pointerClientY = event.clientY
    lastPointerMoveAt = now
    lastPointerAt = now
    swipeStrength = clamp(pointerSpeed / 900, 0, 1)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !pointInsideRoot(event.clientX, event.clientY)) return
    pointerDown = true
    pointerClientX = event.clientX
    pointerClientY = event.clientY
    lastPointerAt = performance.now()
    kickNyxusParticles(particles, 1.5, true)
  }

  function onPointerUp(): void {
    pointerDown = false
  }

  function onReducedMotionChange(event: MediaQueryListEvent): void {
    reducedMotion = event.matches
  }

  function localPointer(): { point: Vec2; distance: number } {
    const rect = rootRef.value?.getBoundingClientRect()
    if (!rect || !Number.isFinite(pointerClientX) || !Number.isFinite(pointerClientY)) {
      return { point: { x: 0, y: 0 }, distance: Number.POSITIVE_INFINITY }
    }
    const point = {
      x: pointerClientX - (rect.left + rect.width / 2),
      y: pointerClientY - (rect.top + rect.height / 2),
    }
    return { point, distance: Math.hypot(point.x, point.y) }
  }

  function localMenuTargets(): Vec2[] {
    const rect = rootRef.value?.getBoundingClientRect()
    if (!rect) return []
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const maximum = canvasExtent() * 0.44

    return MENU_TOOL_ORDER.map((tool) => {
      const target = nyxusMenuTargets.value.find((candidate) => candidate.id === tool)
      if (!target) return { x: 0, y: 0 }
      const x = target.x - centerX
      const y = target.y - centerY
      const distance = Math.max(1, Math.hypot(x, y))
      const scale = Math.min(1, maximum / distance)
      return { x: x * scale, y: y * scale }
    })
  }

  function highlightedMenuIndex(): number {
    return nyxusHighlightedTool.value ? MENU_TOOL_ORDER.indexOf(nyxusHighlightedTool.value) : -1
  }

  function maybeRunCosmicMode(
    now: number,
    eligible: boolean,
    blockStart: boolean,
  ): { mode: NyxusCosmicMode | null; progress: number } {
    if (!eligible) {
      activeCosmicMode = null
      nextCosmicModeAt = Math.max(nextCosmicModeAt, now + 2500)
      return { mode: null, progress: 0 }
    }

    if (activeCosmicMode) {
      const elapsed = (now - cosmicModeStartedAt) / 1000
      const duration = cosmicModeDuration(activeCosmicMode)
      if (elapsed < duration) return { mode: activeCosmicMode, progress: elapsed / duration }
      previousCosmicMode = activeCosmicMode
      activeCosmicMode = null
      nextCosmicModeAt = now + randomCosmicModeDelay()
    }

    if (blockStart || now < nextCosmicModeAt) return { mode: null, progress: 0 }
    const candidates = COSMIC_MODES.filter((candidate) => candidate !== previousCosmicMode)
    activeCosmicMode = candidates[Math.floor(Math.random() * candidates.length)] ?? 'blackHole'
    cosmicModeStartedAt = now
    return { mode: activeCosmicMode, progress: 0 }
  }

  function syncAction(now: number): number {
    if (props.action !== previousAction) {
      if (previousAction === 'dragging') {
        releaseStartedAt = now
        releaseVelocityX = pointerVelocityX
        releaseVelocityY = pointerVelocityY
      }
      previousAction = props.action
    }
    const key = `${props.action}:${props.reaction ?? ''}:${props.mood}`
    if (key !== lastActionKey) {
      lastActionKey = key
      actionStartedAt = now
      if (props.action === 'clicked' || props.reaction) kickNyxusParticles(particles, 2.2, true)
    }
    return Math.max(0, (now - actionStartedAt) / 1000)
  }

  function createInput(now: number): NyxusParticleInput {
    const pointer = localPointer()
    const pointerIsFresh = now - lastPointerAt < 1400
    const connected = !props.respectConnection || connection.status !== 'disconnected'
    const menuTargets = nyxusMenuOpen.value ? localMenuTargets() : []
    const pointerNear = pointerIsFresh && pointer.distance <= props.size * 1.45
    const cosmic = maybeRunCosmicMode(
      now,
      (props.action === 'idle' || props.action === 'walk') &&
        !props.working &&
        !nyxusMenuOpen.value &&
        !props.reaction,
      pointerNear,
    )
    const releaseAge = Math.max(0, (now - releaseStartedAt) / 1000)
    const releaseStrength = releaseAge < 5 ? Math.exp(-releaseAge / 1.25) : 0

    return {
      action: props.action,
      mood: props.mood,
      working: props.working,
      reaction: props.reaction,
      connected,
      menuOpen: nyxusMenuOpen.value,
      menuTargets,
      highlightedMenuIndex: highlightedMenuIndex(),
      pointer: pointer.point,
      pointerDistance: pointer.distance,
      pointerSpeed,
      pointerActive: pointerIsFresh,
      pointerDown,
      actionAge: syncAction(now),
      cosmicMode: cosmic.mode,
      cosmicProgress: cosmic.progress,
      bootProgress: props.boot ? clamp((now - mountedAt) / (reducedMotion ? 900 : 2200), 0, 1) : 1,
      swipe: { x: pointerVelocityX, y: pointerVelocityY },
      swipeStrength,
      release: { x: releaseVelocityX, y: releaseVelocityY },
      releaseStrength,
      time: now / 1000,
      size: props.size,
    }
  }

  /** 帧间衰减：swipe 与 pointer 速度逐帧回落（原 frame 内逻辑）。 */
  function decay(dt: number): void {
    swipeStrength *= Math.pow(0.88, dt * 60)
    pointerSpeed *= Math.pow(0.9, dt * 60)
  }

  onMounted(() => {
    mountedAt = performance.now()
    actionStartedAt = mountedAt
    nextCosmicModeAt = mountedAt + randomCosmicModeDelay()
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = reducedMotionQuery.matches
    reducedMotionQuery.addEventListener('change', onReducedMotionChange)
  })

  onBeforeUnmount(() => {
    reducedMotionQuery?.removeEventListener('change', onReducedMotionChange)
  })

  return {
    getParticles: () => particles,
    createInput,
    decay,
    resetParticles,
    onPointerMove,
    onPointerDown,
    onPointerUp,
    isReducedMotion: () => reducedMotion,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
