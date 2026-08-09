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
  createNyxusParticles,
  kickNyxusParticles,
  promoteNyxusParticleAt,
  type NyxusParticle,
  type NyxusParticleInput,
  type NyxusReaction,
  type NyxusServiceState,
  type NyxusNearbyPet,
  type Vec2,
} from '../particles/nyxusParticleEngine'
import {
  nyxusHighlightedTool,
  nyxusMenuOpen,
  nyxusMenuTargets,
  type NyxusMenuTool,
} from '../nyxusUiState'
import type { PetAction, PetMood } from '@/features/pets/types/types'
import { createNyxusCosmicScheduler, nyxusForcedCosmicState } from './cosmicScheduler'

export interface NyxusInputProps {
  action: PetAction
  mood: PetMood
  working: boolean
  size: number
  reaction: NyxusReaction | null
  boot: boolean
  respectConnection: boolean
  nearbyPet: NyxusNearbyPet | null
  interactive: boolean
}

/** 归一化后的有符号角增量，供绕圈手势与单测共用。 */
export function nyxusAngularDelta(previous: Vec2, next: Vec2): number {
  const previousAngle = Math.atan2(previous.y, previous.x)
  const nextAngle = Math.atan2(next.y, next.x)
  let delta = nextAngle - previousAngle
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

export function nyxusOuterDiskHit(distance: number, size: number): boolean {
  return distance >= size * 0.34 && distance <= size * 1.02
}

const MENU_TOOL_ORDER: readonly NyxusMenuTool[] = ['create', 'chat', 'settings']

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
  let armPhaseOffset = 0
  let previousOrbitPoint: Vec2 | null = null
  let tidalTailDirection: Vec2 = { x: 0, y: 0 }
  let tidalTailStrength = 0
  let dwellStartedAt = 0
  let dwellPoint: Vec2 | null = null
  let starFormationStartedAt = Number.NEGATIVE_INFINITY
  let starFormationPoint: Vec2 | null = null
  let pendingBirthPoint: Vec2 | null = null
  let pointerDownAt: Vec2 | null = null
  const cosmicScheduler = createNyxusCosmicScheduler()
  let reducedMotion = false
  let reducedMotionQuery: MediaQueryList | undefined

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
    if (!props.interactive) return
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
    const local = localPointer()
    if (pointerSpeed > 620 && local.distance <= props.size * 1.3) {
      const speed = Math.max(1, pointerSpeed)
      tidalTailDirection = { x: -pointerVelocityX / speed, y: -pointerVelocityY / speed }
      tidalTailStrength = clamp(pointerSpeed / 1450, 0, 0.72)
    }
    if (local.distance >= props.size * 0.22 && local.distance <= props.size * 1.22) {
      if (previousOrbitPoint) {
        armPhaseOffset = clamp(armPhaseOffset + nyxusAngularDelta(previousOrbitPoint, local.point) * 0.11, -0.72, 0.72)
      }
      previousOrbitPoint = local.point
    } else {
      previousOrbitPoint = null
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (!props.interactive) return
    if (event.button !== 0 || !pointInsideRoot(event.clientX, event.clientY)) return
    pointerDown = true
    pointerClientX = event.clientX
    pointerClientY = event.clientY
    lastPointerAt = performance.now()
    pointerDownAt = localPointer().point
    pendingBirthPoint =
      !nyxusMenuOpen.value && nyxusOuterDiskHit(localPointer().distance, props.size)
        ? pointerDownAt
        : null
    kickNyxusParticles(particles, 1.5, true)
  }

  function onPointerUp(event: PointerEvent): void {
    if (!props.interactive) return
    pointerClientX = event.clientX
    pointerClientY = event.clientY
    const releasedPoint = localPointer().point
    if (
      pendingBirthPoint &&
      pointerDownAt &&
      props.action !== 'dragging' &&
      !nyxusMenuOpen.value &&
      Math.hypot(releasedPoint.x - pointerDownAt.x, releasedPoint.y - pointerDownAt.y) < 7
    ) {
      promoteNyxusParticleAt(particles, pendingBirthPoint)
    }
    pointerDown = false
    pendingBirthPoint = null
    pointerDownAt = null
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

  function updateDwell(now: number, pointer: { point: Vec2; distance: number }): void {
    const canDwell =
      !nyxusMenuOpen.value &&
      pointer.distance >= props.size * 0.36 &&
      pointer.distance <= props.size * 0.94 &&
      pointerSpeed < 72 &&
      now - lastPointerAt < 1300
    if (canDwell) {
      if (!dwellPoint || Math.hypot(pointer.point.x - dwellPoint.x, pointer.point.y - dwellPoint.y) > props.size * 0.1) {
        dwellStartedAt = now
        dwellPoint = pointer.point
      } else if (now - dwellStartedAt > 900 && !starFormationPoint) {
        starFormationPoint = dwellPoint
        starFormationStartedAt = now
      }
    } else {
      dwellStartedAt = 0
      dwellPoint = null
    }
    if (now - starFormationStartedAt > 5200) starFormationPoint = null
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
    updateDwell(now, pointer)
    const pointerIsFresh = now - lastPointerAt < 1400
    const serviceState: NyxusServiceState = props.respectConnection
      ? connection.status
      : 'connected'
    const connected = serviceState !== 'disconnected'
    // 重连期间保留普通星系，但暂时压低工作态的环系/波纹，避免状态快速往返时显得躁动。
    const menuTargets = props.interactive && nyxusMenuOpen.value ? localMenuTargets() : []
    const pointerNear = props.interactive && pointerIsFresh && pointer.distance <= props.size * 1.45
    const forcedCosmic = nyxusForcedCosmicState(serviceState, props.working)
    if (serviceState === 'disconnected') cosmicScheduler.cancel(now, reducedMotion)
    else if (props.working) cosmicScheduler.update(now, false, false, reducedMotion)
    const cosmic = forcedCosmic ?? cosmicScheduler.update(
      now,
      serviceState === 'connected' &&
        (props.action === 'idle' || props.action === 'walk') &&
        !nyxusMenuOpen.value &&
        !props.reaction,
      pointerNear,
      reducedMotion,
    )
    const releaseAge = Math.max(0, (now - releaseStartedAt) / 1000)
    const releaseStrength = releaseAge < 5 ? Math.exp(-releaseAge / 1.25) : 0

    return {
      action: props.action,
      mood: props.mood,
      working: props.working,
      reaction: props.reaction,
      serviceState,
      connected,
      menuOpen: props.interactive && nyxusMenuOpen.value,
      menuTargets,
      highlightedMenuIndex: highlightedMenuIndex(),
      pointer: pointer.point,
      pointerDistance: pointer.distance,
      pointerSpeed,
      pointerActive: props.interactive && pointerIsFresh,
      pointerDown,
      actionAge: syncAction(now),
      cosmicMode: cosmic.mode,
      cosmicProgress: cosmic.progress,
      bootProgress: props.boot ? clamp((now - mountedAt) / (reducedMotion ? 900 : 2200), 0, 1) : 1,
      swipe: { x: pointerVelocityX, y: pointerVelocityY },
      swipeStrength,
      armPhaseOffset,
      tidalTailDirection,
      tidalTailStrength,
      starFormationPoint,
      starFormationStrength: starFormationPoint
        ? clamp(1 - Math.max(0, now - starFormationStartedAt - 3800) / 1400, 0, 1) * 0.46
        : 0,
      nearbyPet: props.nearbyPet,
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
    armPhaseOffset *= Math.pow(0.992, dt * 60)
    tidalTailStrength *= Math.pow(0.955, dt * 60)
  }

  onMounted(() => {
    mountedAt = performance.now()
    actionStartedAt = mountedAt
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = reducedMotionQuery.matches
    cosmicScheduler.initialize(mountedAt, reducedMotion)
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
