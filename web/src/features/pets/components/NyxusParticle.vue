<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConnectionStore } from '@/stores'
import {
  contributesToNyxusFog,
  cosmicModeDuration,
  createNyxusParticles,
  kickNyxusParticles,
  nyxusChromaticStrength,
  nyxusParticleCoreRadius,
  nyxusParticleHaloRadius,
  resolveNyxusMode,
  stepNyxusParticles,
  toneForNyxus,
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
import type { PetAction, PetMood } from '../types/types'

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

const COSMIC_MODES: readonly NyxusCosmicMode[] = [
  'blackHole',
  'pulsar',
  'binary',
  'supernova',
  'tidalRings',
]
const MENU_TOOL_ORDER: readonly NyxusMenuTool[] = ['create', 'chat', 'history', 'settings']

let particles: NyxusParticle[] = []
let raf = 0
let mountedAt = 0
let lastFrameAt = 0
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
let pausedByVisibility = false
let reducedMotion = false
let reducedMotionQuery: MediaQueryList | undefined
const glowTextures = new Map<string, HTMLCanvasElement>()
let shadowCanvas: HTMLCanvasElement | undefined
let shadowContext: CanvasRenderingContext2D | null = null

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function randomCosmicModeDelay(): number {
  const base = 12000 + Math.random() * 10000
  return reducedMotion ? base * 2.2 : base
}

function resetParticles(): void {
  particles = createNyxusParticles(particleCount.value)
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

function onVisibilityChange(): void {
  pausedByVisibility = document.hidden
  if (!pausedByVisibility) {
    lastFrameAt = performance.now()
    raf = requestAnimationFrame(frame)
  }
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
  const maximum = canvasExtent.value * 0.44

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

function colorWithAlpha(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '')
  const value = Number.parseInt(normalized, 16)
  const red = (value >> 16) & 255
  const green = (value >> 8) & 255
  const blue = value & 255
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function glowTexture(color: string): HTMLCanvasElement {
  const cached = glowTextures.get(color)
  if (cached) return cached
  const texture = document.createElement('canvas')
  texture.width = 32
  texture.height = 32
  const context = texture.getContext('2d')
  if (context) {
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16)
    gradient.addColorStop(0, colorWithAlpha(color, 1))
    gradient.addColorStop(0.18, colorWithAlpha(color, 0.9))
    gradient.addColorStop(0.48, colorWithAlpha(color, 0.3))
    gradient.addColorStop(1, colorWithAlpha(color, 0))
    context.fillStyle = gradient
    context.fillRect(0, 0, 32, 32)
  }
  glowTextures.set(color, texture)
  return texture
}

function resizeCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  const extent = canvasExtent.value
  const ratio = Math.min(2.5, window.devicePixelRatio || 1)
  const width = Math.round(extent * ratio)
  if (canvas.width === width && canvas.height === width) return
  canvas.width = width
  canvas.height = width
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
}

function ensureShadowSurface(extent: number, ratio: number): CanvasRenderingContext2D | null {
  shadowCanvas ??= document.createElement('canvas')
  const width = Math.round(extent * ratio)
  if (shadowCanvas.width !== width || shadowCanvas.height !== width) {
    shadowCanvas.width = width
    shadowCanvas.height = width
    shadowContext = shadowCanvas.getContext('2d')
  }
  return shadowContext
}

function fogMenuTargets(input: NyxusParticleInput): Vec2[] {
  const highlighted =
    input.highlightedMenuIndex >= 0 ? input.menuTargets[input.highlightedMenuIndex] : undefined
  if (!highlighted) return input.menuTargets
  return input.menuTargets.map((target, index) => {
    if (index === input.highlightedMenuIndex) return target
    return {
      x: target.x + (highlighted.x - target.x) * 0.6,
      y: target.y + (highlighted.y - target.y) * 0.6,
    }
  })
}

function renderReachFog(
  mask: CanvasRenderingContext2D,
  input: NyxusParticleInput,
  maskTexture: HTMLCanvasElement,
): void {
  const distance = input.pointerDistance
  if (!input.pointerActive || !Number.isFinite(distance) || distance >= input.size * 1.45) return

  const influence = 1 - clamp((distance - input.size * 0.35) / (input.size * 1.1), 0, 1)
  const direction = {
    x: input.pointer.x / Math.max(1, distance),
    y: input.pointer.y / Math.max(1, distance),
  }
  const normal = { x: -direction.y, y: direction.x }
  const reach = clamp(distance, input.size * 0.3, input.size * 0.98)
  const streams = [-1, 0, 1]

  for (const stream of streams) {
    for (let step = 0; step <= 8; step += 1) {
      const t = step / 8
      const eased = t * t * (3 - 2 * t)
      const curve =
        Math.sin(t * Math.PI) *
        input.size *
        (0.055 * stream + Math.sin(input.time * 0.31 + stream * 1.7) * 0.024)
      const width = input.size * (0.2 - t * 0.145) * (0.88 + Math.abs(stream) * 0.16)
      const x = direction.x * reach * eased + normal.x * curve
      const y = direction.y * reach * eased + normal.y * curve

      mask.globalAlpha = influence * (0.055 + (1 - t) * 0.045)
      mask.drawImage(maskTexture, x - width, y - width, width * 2, width * 2)
    }
  }
}

function renderShadowMask(
  context: CanvasRenderingContext2D,
  input: NyxusParticleInput,
  extent: number,
): void {
  const ratio = Math.min(2.5, window.devicePixelRatio || 1)
  const mask = ensureShadowSurface(extent, ratio)
  if (!mask || !shadowCanvas) return
  const maskTexture = glowTexture('#ffffff')

  mask.setTransform(ratio, 0, 0, ratio, 0, 0)
  mask.clearRect(0, 0, extent, extent)
  mask.save()
  mask.translate(extent / 2, extent / 2)
  mask.globalCompositeOperation = 'lighter'
  const renderMode = resolveNyxusMode(input)

  const centerRadius = input.size * 0.24
  mask.globalAlpha = 0.38
  mask.drawImage(maskTexture, -centerRadius, -centerRadius, centerRadius * 2, centerRadius * 2)
  mask.globalAlpha = 0.14
  for (let index = 0; index < 2; index += 1) {
    const angle = input.time * 0.12 + index * Math.PI
    const offset = input.size * 0.075
    const radius = input.size * 0.18
    const x = Math.cos(angle) * offset
    const y = Math.sin(angle * 1.3) * offset
    mask.drawImage(maskTexture, x - radius, y - radius, radius * 2, radius * 2)
  }

  mask.globalAlpha = 0.18
  for (const particle of particles) {
    if (!contributesToNyxusFog(particle)) continue
    const radius = input.size * (0.095 + particle.size * 0.045)
    mask.drawImage(maskTexture, particle.x - radius, particle.y - radius, radius * 2, radius * 2)
  }

  if (renderMode === 'reach') renderReachFog(mask, input, maskTexture)

  if (input.menuOpen && input.menuTargets.length > 0) {
    const targets = fogMenuTargets(input)
    mask.filter = `blur(${Math.max(3, input.size * 0.035)}px)`
    mask.lineCap = 'round'
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!
      const highlighted = index === input.highlightedMenuIndex
      mask.globalAlpha = highlighted ? 0.58 : 0.27
      mask.lineWidth = input.size * (highlighted ? 0.095 : 0.065)
      mask.strokeStyle = '#ffffff'
      mask.beginPath()
      mask.moveTo(0, 0)
      mask.quadraticCurveTo(-target.y * 0.16, target.x * 0.16, target.x, target.y)
      mask.stroke()
    }
    mask.filter = 'none'
  }
  mask.restore()

  mask.setTransform(ratio, 0, 0, ratio, 0, 0)
  mask.globalCompositeOperation = 'source-in'
  mask.globalAlpha = 1
  mask.fillStyle = toneForNyxus(input).core
  mask.fillRect(0, 0, extent, extent)
  mask.globalCompositeOperation = 'source-over'

  const spread = input.size * 0.07
  context.save()
  context.globalAlpha = 0.12
  context.filter = `blur(${Math.max(7, input.size * 0.085)}px)`
  context.drawImage(shadowCanvas, -spread, -spread, extent + spread * 2, extent + spread * 2)
  context.restore()
  context.save()
  context.globalAlpha = 0.18
  context.drawImage(shadowCanvas, 0, 0, extent, extent)
  context.restore()
}

/**
 * 中心在线状态点(仅主 pet,叠加于粒子之上,独立坐标系)。
 * core 2px 锚定不动(在线白/离线黑);halo 色略别于 core(在线暖金/离线暗紫),
 * 椭圆 rotate 自旋 + 双频扰动 → 明显旋转感。
 * connecting 明灭走 input.time 正弦;离线 halo 用 source-over(lighter 下暗色不可见)。
 */
function renderStatusDot(context: CanvasRenderingContext2D, input: NyxusParticleInput): void {
  // binary 双星阶段有自身双心结构,中心状态点与之冲突 → 隐藏
  if (input.cosmicMode === 'binary') return
  const status = connection.status
  const breath =
    status === 'connecting' ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(input.time * 4)) : 1
  const isOffline = status === 'disconnected'
  // core 锚定 2px 不动;halo 色略别于 core(在线暖金/离线暗紫)+ 椭圆自旋 + 双频扰动 → 明显旋转感
  const coreColor = isOffline ? '#0b0b0c' : '#ffffff'
  const haloColor = isOffline ? '#2a1a30' : '#ffd9a0'
  const glow = glowTexture(haloColor)
  const haloRadius = 16
  const wobble = Math.sin(input.time * 2.3) * 0.07 + Math.sin(input.time * 5.1) * 0.035
  const haloR = haloRadius * (1 + wobble)
  context.save()
  context.rotate(input.time * 0.8)
  context.scale(1, 0.72)
  context.globalCompositeOperation = isOffline ? 'source-over' : 'lighter'
  context.globalAlpha = (isOffline ? 0.55 : 0.9) * breath
  context.drawImage(glow, -haloR, -haloR, haloR * 2, haloR * 2)
  context.restore()
  context.globalCompositeOperation = 'source-over'
  context.globalAlpha = breath
  context.fillStyle = coreColor
  context.beginPath()
  context.arc(0, 0, 2, 0, Math.PI * 2)
  context.fill()
}

function render(context: CanvasRenderingContext2D, input: NyxusParticleInput): void {
  const extent = canvasExtent.value
  const tone = toneForNyxus(input)
  const redGlow = glowTexture(tone.star)

  context.clearRect(0, 0, extent, extent)
  renderShadowMask(context, input, extent)
  context.save()
  context.translate(extent / 2, extent / 2)

  for (let brightness = 0; brightness <= 1; brightness += 1) {
    context.fillStyle = colorWithAlpha(tone.spark, brightness === 0 ? 0.07 : 0.14)
    context.beginPath()
    for (const particle of particles) {
      if (particle.brightness !== brightness) continue
      const radius = nyxusParticleHaloRadius(particle)
      context.moveTo(particle.x + radius, particle.y)
      context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
    }
    context.fill()
  }

  for (let brightness = 0; brightness <= 1; brightness += 1) {
    context.fillStyle = colorWithAlpha(tone.spark, brightness === 0 ? 0.5 : 0.74)
    context.beginPath()
    for (const particle of particles) {
      if (particle.brightness !== brightness) continue
      const radius = nyxusParticleCoreRadius(particle)
      context.moveTo(particle.x + radius, particle.y)
      context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
    }
    context.fill()
  }

  context.globalCompositeOperation = 'lighter'
  const glowCells = new Map<string, number>()
  const glowCellSize = Math.max(3, (input.size / 112) * 4)
  for (const particle of particles) {
    const redStrength = nyxusChromaticStrength(particle, input.time)
    if (particle.brightness < 2 && redStrength <= 0) continue
    const cellKey = `${Math.floor(particle.x / glowCellSize)}:${Math.floor(particle.y / glowCellSize)}`
    const cellCount = glowCells.get(cellKey) ?? 0
    if (cellCount >= 3) continue
    glowCells.set(cellKey, cellCount + 1)
    const twinkle =
      0.52 + Math.sin(input.time * (0.65 + particle.orbit * 0.45) + particle.phase) * 0.32
    const highlighted =
      input.highlightedMenuIndex >= 0 &&
      (particle.armSlot === input.highlightedMenuIndex || particle.armRank < 0.72)
        ? 1.35
        : 1
    const alpha = clamp(twinkle * highlighted, 0.16, 1)
    if (particle.brightness >= 2) {
      const radius = nyxusParticleHaloRadius(particle) * particle.birthT
      // 恒星固定太阳红;爆炸渐隐(explosionT) + 生长渐入(birthT)
      const fade = (1 - particle.explosionT) * particle.birthT
      context.globalAlpha = alpha * (particle.brightness === 3 ? 0.3 : 0.16) * fade
      context.drawImage(
        redGlow,
        particle.x - radius,
        particle.y - radius,
        radius * 2,
        radius * 2,
      )
    }
    if (redStrength > 0) {
      const radius = 2.25 + particle.size * 0.7
      context.globalAlpha = alpha * redStrength * 0.36
      context.drawImage(redGlow, particle.x - radius, particle.y - radius, radius * 2, radius * 2)
    }
  }
  // 恒星爆炸闪光环:径向扩张 + alpha 中峰(sin)渐隐
  for (const particle of particles) {
    if (particle.explosionT <= 0) continue
    const progress = particle.explosionT
    const ringRadius = (4 + particle.size * 2.2) * (0.4 + progress * 1.6)
    context.globalAlpha = Math.sin(progress * Math.PI) * 0.55
    context.drawImage(
      redGlow,
      particle.x - ringRadius,
      particle.y - ringRadius,
      ringRadius * 2,
      ringRadius * 2,
    )
  }
  context.globalCompositeOperation = 'source-over'
  context.fillStyle = tone.star // 恒星固定太阳红
  for (const particle of particles) {
    if (particle.brightness < 2) continue
    const fade = (1 - particle.explosionT) * particle.birthT // 爆炸渐隐 + 生长渐入
    if (fade <= 0) continue
    const radius = nyxusParticleCoreRadius(particle) * particle.birthT
    context.globalAlpha = (particle.brightness === 3 ? 1 : 0.92) * fade
    context.beginPath()
    context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
    context.fill()
  }
  context.globalAlpha = 0.96
  context.fillStyle = tone.star
  context.beginPath()
  for (const particle of particles) {
    const redStrength = nyxusChromaticStrength(particle, input.time)
    if (redStrength <= 0) continue
    context.globalAlpha = redStrength * 0.96
    const radius = nyxusParticleCoreRadius(particle) * (1 + redStrength * 0.08)
    context.moveTo(particle.x + radius, particle.y)
    context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
    context.fill()
    context.beginPath()
  }
  context.restore()
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  if (props.statusDot) {
    context.save()
    context.translate(extent / 2, extent / 2)
    renderStatusDot(context, input)
    context.restore()
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
  swipeStrength *= Math.pow(0.88, dt * 60)
  pointerSpeed *= Math.pow(0.9, dt * 60)

  resizeCanvas(canvas, context)
  const input = createInput(now)
  stepNyxusParticles(particles, input, reducedMotion ? Math.min(dt, 1 / 45) : dt)
  mode.value = resolveNyxusMode(input)
  cosmicModeLabel.value = input.cosmicMode ?? 'nebula'
  render(context, input)
  raf = requestAnimationFrame(frame)
}

watch(particleCount, resetParticles)

onMounted(() => {
  mountedAt = performance.now()
  actionStartedAt = mountedAt
  nextCosmicModeAt = mountedAt + randomCosmicModeDelay()
  resetParticles()
  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion = reducedMotionQuery.matches
  reducedMotionQuery.addEventListener('change', onReducedMotionChange)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })
  window.addEventListener('pointercancel', onPointerUp, { passive: true })
  document.addEventListener('visibilitychange', onVisibilityChange)
  raf = requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  reducedMotionQuery?.removeEventListener('change', onReducedMotionChange)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  glowTextures.clear()
  shadowCanvas = undefined
  shadowContext = null
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
