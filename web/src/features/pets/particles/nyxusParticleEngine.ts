import type { PetAction, PetMood } from '../types/types'

export interface Vec2 {
  x: number
  y: number
}

export type NyxusReaction = 'positive' | 'agitated' | 'error'

export type NyxusCosmicMode = 'blackHole' | 'pulsar' | 'binary' | 'supernova' | 'tidalRings'

export type NyxusRenderMode =
  'dragging' | 'released' | 'menu' | 'working' | 'reach' | 'reaction' | 'cosmic' | 'sleep' | 'idle'

export interface NyxusParticle {
  x: number
  y: number
  vx: number
  vy: number
  angle: number
  radius: number
  phase: number
  size: number
  brightness: number
  colorCycle: number
  /** 云团色带与恒星色温均由种子固定，保证重建后的视觉分布稳定。 */
  cloudColor: number
  starColor: number
  armRank: number
  armT: number
  armSlot: number
  galaxyArm: number
  noise: number
  orbit: number
  /** 爆炸进度:0 静默;>0 爆炸中(0→1),达到 1 恒星消逝降级为白点 */
  explosionT: number
  /** 生长进度:1 已长成(默认);>0 且 <1 渐入中,promote 后白点缓慢生长为恒星 */
  birthT: number
}

export interface NyxusParticleInput {
  action: PetAction
  mood: PetMood
  working: boolean
  reaction: NyxusReaction | null
  connected: boolean
  menuOpen: boolean
  menuTargets: Vec2[]
  highlightedMenuIndex: number
  pointer: Vec2
  pointerDistance: number
  pointerSpeed: number
  pointerActive: boolean
  pointerDown: boolean
  actionAge: number
  cosmicMode: NyxusCosmicMode | null
  cosmicProgress: number
  bootProgress: number
  swipe: Vec2
  swipeStrength: number
  release: Vec2
  releaseStrength: number
  time: number
  size: number
}

export interface NyxusTone {
  core: string
  dust: string
  star: string
  accent: string
  spark: string
}

const HIGHLIGHT_RATIO = 0.02
const SPARK_RATIO = 0.003
const HIGHLIGHT_BASE_SPACING = 0.075
export const NYXUS_CHROMATIC_CYCLE_SECONDS = 84
/** 恒星爆发与再生均放缓，让生灭循环能被看清。 */
const EXPLOSION_DURATION = 8
const EXPLOSION_RATE = 0.0015
const BIRTH_DURATION = 8
const NYXUS_CHROMATIC_WINDOW = 0.032

const COSMIC_MODE_DURATION: Record<NyxusCosmicMode, number> = {
  blackHole: 72,
  pulsar: 64,
  binary: 80,
  supernova: 64,
  tidalRings: 72,
}

const CLOUD_COLORS = ['#a45cff', '#6d72ff', '#277cff', '#22d5ff', '#11d8c0', '#ff4fb4'] as const
const COHESIVE_CLOUD_COLORS = ['#a45cff', '#786cff', '#4b83ff', '#2aaeff'] as const
const STAR_HALO_COLORS = ['#a45cff', '#22d5ff', '#ff4fb4', '#4b83ff'] as const
const WHITE_STAR_CORE = '#ffffff'

const NEBULA_TONE: NyxusTone = {
  core: '#333451',
  dust: '#aeb8d2',
  star: '#fff0c1',
  accent: '#9daed3',
  spark: '#dbe9ff',
}

const COSMIC_MODE_TONES: Record<NyxusCosmicMode, NyxusTone> = {
  blackHole: {
    core: '#302d4a',
    dust: '#aeb0ce',
    star: '#d9e9ff',
    accent: '#b8b1c4',
    spark: '#f1ecef',
  },
  pulsar: {
    core: '#2c304b',
    dust: '#a8b8d0',
    star: '#d9e9ff',
    accent: '#b4c1c3',
    spark: '#f2eeee',
  },
  binary: {
    core: '#393244',
    dust: '#c4b4aa',
    star: '#fff0c1',
    accent: '#d3c29f',
    spark: '#f3eee8',
  },
  supernova: {
    core: '#41333c',
    dust: '#cfb7a9',
    star: '#ffc58e',
    accent: '#d4c199',
    spark: '#f5f0e7',
  },
  tidalRings: {
    core: '#332d4a',
    dust: '#b5aecb',
    star: '#e0c9ff',
    accent: '#aec0b9',
    spark: '#f2edef',
  },
}

const TAU = Math.PI * 2

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** 特殊宇宙形态的统一淡入淡出强度；0/1 为静态星云，中央区为完整形态。 */
export function nyxusCosmicTransitionStrength(progress: number): number {
  const enter = smoothstep(0, 0.22, progress)
  const leave = 1 - smoothstep(0.72, 1, progress)
  return enter * leave
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let result = value
    result = Math.imul(result ^ (result >>> 15), result | 1)
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

export function createNyxusParticles(count: number, seed = 0x4e797875): NyxusParticle[] {
  const random = mulberry32(seed)
  const particles = Array.from({ length: count }, () => {
    const angle = random() * TAU
    const brightnessRoll = random()
    const brightness = brightnessRoll > 0.69 ? 1 : 0
    const radius = Math.pow(random(), brightness === 0 ? 1.15 : 0.55)
    const initialDistance = radius * 46
    const x = Math.cos(angle) * initialDistance + (random() - 0.5) * 12
    const y = Math.sin(angle) * initialDistance + (random() - 0.5) * 12
    return {
      x,
      y,
      vx: (random() - 0.5) * 7,
      vy: (random() - 0.5) * 7,
      angle,
      radius,
      phase: random() * TAU,
      size: 0.45 + random() * 0.9,
      brightness,
      colorCycle: 0,
      cloudColor: Math.floor(random() * CLOUD_COLORS.length),
      starColor: Math.floor(random() * STAR_HALO_COLORS.length),
      armRank: random(),
      armT: random(),
      armSlot: Math.floor(random() * 3),
      galaxyArm: Math.floor(random() * 6),
      noise: random() * 2 - 1,
      orbit: 0.35 + random() * 0.9,
      explosionT: 0,
      birthT: 1,
    }
  })

  const colorOrder = [...particles].sort((left, right) => left.phase - right.phase)
  for (let index = 0; index < colorOrder.length; index += 1) {
    colorOrder[index]!.colorCycle = index / Math.max(1, colorOrder.length)
  }

  const desiredHighlights = Math.round(count * HIGHLIGHT_RATIO)
  const desiredSparks = Math.round(count * SPARK_RATIO)
  const accepted: NyxusParticle[] = []
  const candidates = [...particles].sort((left, right) => left.phase - right.phase)
  for (const candidate of candidates) {
    const x = Math.cos(candidate.angle) * candidate.radius
    const y = Math.sin(candidate.angle) * candidate.radius
    const hasSpace = accepted.every((other) => {
      const ox = Math.cos(other.angle) * other.radius
      const oy = Math.sin(other.angle) * other.radius
      return Math.hypot(x - ox, y - oy) >= HIGHLIGHT_BASE_SPACING
    })
    if (!hasSpace) continue
    candidate.brightness = accepted.length < desiredSparks ? 3 : 2
    accepted.push(candidate)
    if (accepted.length >= desiredHighlights) break
  }
  return particles
}

export function cosmicModeDuration(mode: NyxusCosmicMode): number {
  return COSMIC_MODE_DURATION[mode]
}

export function contributesToNyxusFog(particle: NyxusParticle): boolean {
  return particle.brightness === 0 && particle.armRank >= 0.12 && particle.armRank <= 0.66
}

/** 由同一暗点层生成的星云云团色；缓慢跨越相邻色带，避免闪烁。 */
export function nyxusCloudColor(particle: NyxusParticle, time: number, cohesion = 0): string {
  const offset = particle.cloudColor + particle.phase / TAU
  const position =
    ((offset + time / 96) % CLOUD_COLORS.length + CLOUD_COLORS.length) % CLOUD_COLORS.length
  const index = Math.floor(position)
  const next = (index + 1) % CLOUD_COLORS.length
  const individual = mixHexColor(
    CLOUD_COLORS[index]!,
    CLOUD_COLORS[next]!,
    smoothstep(0.16, 0.84, position - index),
  )
  const cohesivePosition =
    ((time / 120) % COHESIVE_CLOUD_COLORS.length + COHESIVE_CLOUD_COLORS.length) %
    COHESIVE_CLOUD_COLORS.length
  const cohesiveIndex = Math.floor(cohesivePosition)
  const cohesiveNext = (cohesiveIndex + 1) % COHESIVE_CLOUD_COLORS.length
  const cohesive = mixHexColor(
    COHESIVE_CLOUD_COLORS[cohesiveIndex]!,
    COHESIVE_CLOUD_COLORS[cohesiveNext]!,
    smoothstep(0.16, 0.84, cohesivePosition - cohesiveIndex),
  )
  return mixHexColor(individual, cohesive, smoothstep(0.16, 0.88, cohesion) * 0.72)
}

/** 恒星核心始终纯白，保证在鲜艳星云中清晰可辨。 */
export function nyxusStarColor(particle: NyxusParticle): string {
  void particle
  return WHITE_STAR_CORE
}

/** 所属色只用于恒星的柔光、诞生和爆发环，维持生死阶段的鲜艳辨识度。 */
export function nyxusStarHaloColor(particle: NyxusParticle): string {
  return STAR_HALO_COLORS[particle.starColor % STAR_HALO_COLORS.length]!
}

export function nyxusChromaticStrength(particle: NyxusParticle, time: number): number {
  // 恒星由独立色温绘制；仅普通点保留极少量暖色闪烁。
  if (particle.brightness >= 2) return 0
  const cycle = (((particle.colorCycle + time / NYXUS_CHROMATIC_CYCLE_SECONDS) % 1) + 1) % 1
  const distance = Math.min(cycle, 1 - cycle)
  const outerEdge = NYXUS_CHROMATIC_WINDOW / 2
  const innerEdge = outerEdge * 0.34
  if (distance >= outerEdge) return 0
  return 1 - smoothstep(innerEdge, outerEdge, distance)
}

export function nyxusParticleCoreRadius(particle: NyxusParticle): number {
  if (particle.brightness === 0) return 0.2 + particle.size * 0.22
  if (particle.brightness === 1) return 0.3 + particle.size * 0.3
  if (particle.brightness === 2) return 0.26 + particle.size * 0.22
  return 0.26 + particle.size * 0.22
}

export function nyxusParticleHaloRadius(particle: NyxusParticle): number {
  if (particle.brightness === 0) return 0.42 + particle.size * 0.18
  if (particle.brightness === 1) return 0.72 + particle.size * 0.38
  if (particle.brightness === 2) return 0.6 + particle.size * 0.28
  return 0.72 + particle.size * 0.38
}

export function resolveNyxusMode(input: NyxusParticleInput): NyxusRenderMode {
  if (input.action === 'dragging') return 'dragging'
  if (input.releaseStrength > 0.035) return 'released'
  if (input.menuOpen && input.menuTargets.length > 0) return 'menu'
  if (input.working || input.action === 'chatting') return 'working'
  if (input.pointerActive && input.pointerDistance < input.size * 1.45) return 'reach'
  if (input.action === 'clicked' || input.reaction) return 'reaction'
  if (input.cosmicMode) return 'cosmic'
  if (input.action === 'sleep') return 'sleep'
  return 'idle'
}

function mixHexColor(from: string, to: string, amount: number): string {
  const fromValue = Number.parseInt(from.slice(1), 16)
  const toValue = Number.parseInt(to.slice(1), 16)
  const channel = (shift: number) => {
    const start = (fromValue >> shift) & 255
    const end = (toValue >> shift) & 255
    return Math.round(start + (end - start) * amount)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(16)}${channel(8)}${channel(0)}`
}

function mixTone(from: NyxusTone, to: NyxusTone, amount: number): NyxusTone {
  return {
    core: mixHexColor(from.core, to.core, amount),
    dust: mixHexColor(from.dust, to.dust, amount),
    star: mixHexColor(from.star, to.star, amount),
    accent: mixHexColor(from.accent, to.accent, amount),
    spark: mixHexColor(from.spark, to.spark, amount),
  }
}

export function toneForNyxus(input: NyxusParticleInput): NyxusTone {
  if (!input.connected || input.reaction === 'error') {
    return {
      core: '#41353f',
      dust: '#b8acb8',
      star: '#ffc9bd',
      accent: '#b9aaad',
      spark: '#eee8e6',
    }
  }
  if (input.working || input.action === 'chatting') {
    return {
      core: '#30324a',
      dust: '#adb8d0',
      star: '#d9e9ff',
      accent: '#afc2c3',
      spark: '#f1ecee',
    }
  }
  if (!input.cosmicMode) return NEBULA_TONE
  const transition = Math.round(nyxusCosmicTransitionStrength(input.cosmicProgress) * 8) / 8
  return mixTone(NEBULA_TONE, COSMIC_MODE_TONES[input.cosmicMode], transition)
}

function curvePoint(start: Vec2, end: Vec2, t: number, bend: number): Vec2 {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const distance = Math.max(1, Math.hypot(dx, dy))
  const nx = -dy / distance
  const ny = dx / distance
  const eased = t * t * (3 - 2 * t)
  const arc = Math.sin(t * Math.PI) * bend
  return { x: start.x + dx * eased + nx * arc, y: start.y + dy * eased + ny * arc }
}

function mixAngle(from: number, to: number, amount: number): number {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from))
  return from + difference * amount
}

/** 基于固定粒子种子的旋转周期，始终落在 30–60 秒范围。 */
export function nyxusRotationPeriod(particle: NyxusParticle): number {
  return 30 + clamp((particle.orbit - 0.35) / 0.9, 0, 1) * 30
}

function cloudTarget(particle: NyxusParticle, input: NyxusParticleInput): Vec2 {
  const baseRadius = input.size * 0.34
  const breath = 1 + Math.sin(input.time * 0.46) * 0.105 + Math.sin(input.time * 0.13 + 1.1) * 0.025
  const shapeTime = input.time * 0.16
  const harmonic =
    1 +
    Math.sin(particle.angle * 2 + shapeTime) * 0.07 +
    Math.sin(particle.angle * 5 - shapeTime * 0.7 + 1.8) * 0.045 +
    Math.sin(particle.radius * 8 - input.time * 0.16 + particle.phase) * 0.035
  const flattening = (1 - Math.cos(input.time * 0.2)) * 0.5
  const axis = 1.02 + flattening * 0.34
  const axisAngle = input.time * 0.021 + Math.sin(input.time * 0.09) * 0.18
  // 每颗恒星/星点的主旋转周期稳定地随机落在 30–60 秒，既有差异也不会频繁转相。
  const orbitPeriod = nyxusRotationPeriod(particle)
  const orbitSpeed = (TAU / orbitPeriod) * (0.94 + particle.orbit * 0.11)
  const freeOrbitAngle = particle.angle + input.time * orbitSpeed
  const armPatternSpeed = (TAU / orbitPeriod) * (0.78 - clamp(particle.radius, 0, 1) * 0.16)
  const armAngle =
    (particle.galaxyArm / 6) * TAU +
    particle.radius * 4.2 +
    input.time * armPatternSpeed +
    particle.noise * 0.13 +
    Math.sin(particle.phase * 0.7) * 0.05
  const armStrength =
    smoothstep(0.14, 0.68, particle.radius) * (0.9 + (1 - particle.armRank) * 0.06)
  const orbitAngle = mixAngle(freeOrbitAngle, armAngle, armStrength)
  const distance = particle.radius * baseRadius * breath * harmonic
  const rawX = Math.cos(orbitAngle) * distance * axis
  const rawY = (Math.sin(orbitAngle) * distance) / axis
  const cosAxis = Math.cos(axisAngle)
  const sinAxis = Math.sin(axisAngle)
  const drift = (0.35 + particle.radius * 0.95) * Math.sin(input.time * 0.34 + particle.phase)

  return {
    x: rawX * cosAxis - rawY * sinAxis + Math.cos(particle.phase) * drift,
    y: rawX * sinAxis + rawY * cosAxis + Math.sin(particle.phase * 1.3) * drift,
  }
}

function menuTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const highlightedTarget =
    input.highlightedMenuIndex >= 0 ? input.menuTargets[input.highlightedMenuIndex] : undefined
  const originalTarget = input.menuTargets[particle.armSlot]
  if (!originalTarget) return body

  if (highlightedTarget && particle.brightness >= 2 && particle.armRank < 0.72) {
    const point = curvePoint(
      body,
      highlightedTarget,
      0.22 + particle.armT * 0.68,
      Math.sin(input.time * 0.55 + particle.phase) * input.size * 0.1,
    )
    return {
      x: point.x + particle.noise * input.size * 0.035,
      y: point.y + Math.sin(particle.phase) * input.size * 0.035,
    }
  }

  if (particle.armRank > 0.26) return body
  const transfer =
    highlightedTarget && particle.armSlot !== input.highlightedMenuIndex
      ? particle.brightness === 0
        ? 0.64
        : 0.48
      : 0
  const target = highlightedTarget
    ? {
        x: originalTarget.x + (highlightedTarget.x - originalTarget.x) * transfer,
        y: originalTarget.y + (highlightedTarget.y - originalTarget.y) * transfer,
      }
    : originalTarget
  const distance = Math.max(1, Math.hypot(target.x, target.y))
  const start = {
    x: (target.x / distance) * input.size * 0.12,
    y: (target.y / distance) * input.size * 0.12,
  }
  const point = curvePoint(
    start,
    target,
    particle.armT,
    Math.sin(input.time * 0.45 + particle.armSlot * 2) * input.size * 0.09,
  )
  const width = (1 - particle.armT) * input.size * 0.065 + 0.7
  const highlight = input.highlightedMenuIndex === particle.armSlot ? 1.25 : 1
  return {
    x: point.x + (-target.y / distance) * particle.noise * width * highlight,
    y: point.y + (target.x / distance) * particle.noise * width * highlight,
  }
}

function reachTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const distance = Math.max(1, input.pointerDistance)
  const direction = { x: input.pointer.x / distance, y: input.pointer.y / distance }
  const influence = 1 - smoothstep(input.size * 0.35, input.size * 1.45, distance)
  if (influence <= 0) return body

  if (particle.armRank < 0.18) {
    const endDistance = clamp(distance, input.size * 0.28, input.size * 0.98)
    const end = { x: direction.x * endDistance, y: direction.y * endDistance }
    const start = { x: direction.x * input.size * 0.11, y: direction.y * input.size * 0.11 }
    const point = curvePoint(
      start,
      end,
      particle.armT * influence,
      Math.sin(input.time * 0.52) * input.size * 0.1,
    )
    const width = (1 - particle.armT) * input.size * 0.07 + 0.8
    return {
      x: point.x + -direction.y * particle.noise * width,
      y: point.y + direction.x * particle.noise * width,
    }
  }

  const projection = Math.max(0, body.x * direction.x + body.y * direction.y)
  const pull = projection * influence * 0.12
  const disturbance = 1 + clamp(input.pointerSpeed / 600, 0, 1) * 0.35
  const radialWave =
    Math.sin(input.time * 1.1 + particle.phase + particle.radius * 7) *
    influence *
    input.size *
    (0.012 + particle.radius * 0.018) *
    disturbance
  const shear =
    Math.cos(particle.phase * 1.7 - input.time * 0.8) *
    influence *
    input.size *
    (0.018 + particle.radius * 0.032) *
    disturbance
  return {
    x: body.x + direction.x * (pull + radialWave) - direction.y * shear,
    y: body.y + direction.y * (pull + radialWave) + direction.x * shear,
  }
}

function draggingTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const pointerDistance = Math.max(1, input.pointerDistance)
  const direction = { x: input.pointer.x / pointerDistance, y: input.pointer.y / pointerDistance }
  const lagScale = (0.25 + particle.radius * 0.75) * input.swipeStrength
  const lag = {
    x: clamp(-input.swipe.x * 0.035 * lagScale, -input.size * 0.65, input.size * 0.65),
    y: clamp(-input.swipe.y * 0.035 * lagScale, -input.size * 0.65, input.size * 0.65),
  }

  if (particle.armRank < 0.3) {
    const captureDistance = clamp(pointerDistance, input.size * 0.08, input.size * 0.62)
    const captured = curvePoint(
      { x: 0, y: 0 },
      { x: direction.x * captureDistance, y: direction.y * captureDistance },
      particle.armT,
      particle.noise * input.size * 0.04,
    )
    return { x: captured.x + lag.x * 0.18, y: captured.y + lag.y * 0.18 }
  }
  return { x: body.x + lag.x, y: body.y + lag.y }
}

function releasedTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const trail = (0.2 + particle.radius * 0.8) * input.releaseStrength
  const curl =
    Math.sin(input.time * 0.7 + particle.phase) * input.size * 0.07 * input.releaseStrength
  const releaseLength = Math.min(
    input.size * 0.78,
    Math.hypot(input.release.x, input.release.y) * 0.045,
  )
  const distance = Math.max(1, Math.hypot(input.release.x, input.release.y))
  const dx = input.release.x / distance
  const dy = input.release.y / distance
  return {
    x: body.x - dx * releaseLength * trail - dy * curl,
    y: body.y - dy * releaseLength * trail + dx * curl,
  }
}

function rotatePoint(point: Vec2, angle: number): Vec2 {
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  }
}

function blendPoint(from: Vec2, to: Vec2, amount: number): Vec2 {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  }
}

function blackHoleTarget(particle: NyxusParticle, input: NyxusParticleInput): Vec2 {
  const radius = input.size * (0.075 + particle.radius * 0.34)
  const speed = 0.17 + (1 - particle.radius) * 0.36 + particle.orbit * 0.035
  const angle = particle.angle + particle.phase * 0.12 + input.time * speed
  const disk = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.2 }
  return rotatePoint(disk, 0.28 + Math.sin(input.time * 0.07) * 0.14)
}

function pulsarTarget(particle: NyxusParticle, input: NyxusParticleInput): Vec2 {
  const tilt = input.time * 0.075 + Math.sin(input.time * 0.11) * 0.28
  if (particle.armRank < 0.14) {
    const side = particle.galaxyArm % 2 === 0 ? 1 : -1
    const length = input.size * (0.12 + particle.armT * 0.72) * side
    return rotatePoint(
      {
        x: particle.noise * input.size * 0.025,
        y: length,
      },
      tilt,
    )
  }

  const radius = input.size * (0.045 + particle.radius * 0.3)
  const angle = particle.angle + input.time * (0.16 + particle.orbit * 0.055)
  return rotatePoint({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * 0.18 }, tilt)
}

function binaryTarget(particle: NyxusParticle, input: NyxusParticleInput): Vec2 {
  const orbitAngle = input.time * 0.16
  const firstCore = {
    x: Math.cos(orbitAngle) * input.size * 0.17,
    y: Math.sin(orbitAngle) * input.size * 0.11,
  }
  const secondCore = { x: -firstCore.x, y: -firstCore.y }
  if (particle.armRank < 0.12) {
    const point = curvePoint(
      firstCore,
      secondCore,
      particle.armT,
      Math.sin(input.time * 0.35 + particle.phase) * input.size * 0.055,
    )
    return {
      x: point.x + particle.noise * input.size * 0.018,
      y: point.y + Math.sin(particle.phase) * input.size * 0.012,
    }
  }

  const center = particle.galaxyArm % 2 === 0 ? firstCore : secondCore
  const localRadius = input.size * (0.025 + particle.radius * 0.135)
  const localAngle = particle.phase + input.time * (0.18 + particle.orbit * 0.07)
  return {
    x: center.x + Math.cos(localAngle) * localRadius,
    y: center.y + Math.sin(localAngle) * localRadius * 0.72,
  }
}

function supernovaTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const progress = input.cosmicProgress
  const collapse = 1 - smoothstep(0, 0.24, progress) * 0.76
  const shell = smoothstep(0.2, 0.52, progress) * (1 - smoothstep(0.72, 0.96, progress))
  const bodyAngle = Math.atan2(body.y, body.x)
  const shellRadius = input.size * (0.36 + particle.noise * 0.035)
  const collapsed = { x: body.x * collapse, y: body.y * collapse }
  const expanded = {
    x: Math.cos(bodyAngle) * shellRadius,
    y: Math.sin(bodyAngle) * shellRadius,
  }
  return blendPoint(collapsed, expanded, shell)
}

function tidalRingsTarget(particle: NyxusParticle, input: NyxusParticleInput): Vec2 {
  const ring = particle.galaxyArm % 3
  const radius = input.size * (0.17 + ring * 0.095 + particle.noise * 0.012)
  const angle = particle.angle + particle.phase * 0.08 + input.time * (0.075 + ring * 0.025)
  const ringPoint = {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius * (0.42 + ring * 0.12),
  }
  return rotatePoint(ringPoint, ring * 0.82 + Math.sin(input.time * 0.09 + ring) * 0.16)
}

function cosmicModeTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const mode = input.cosmicMode
  if (!mode) return body
  const amount = nyxusCosmicTransitionStrength(input.cosmicProgress)
  let target = body
  if (mode === 'blackHole') target = blackHoleTarget(particle, input)
  else if (mode === 'pulsar') target = pulsarTarget(particle, input)
  else if (mode === 'binary') target = binaryTarget(particle, input)
  else if (mode === 'supernova') target = supernovaTarget(particle, body, input)
  else if (mode === 'tidalRings') target = tidalRingsTarget(particle, input)
  return blendPoint(body, target, amount)
}

export function particleTarget(particle: NyxusParticle, input: NyxusParticleInput): Vec2 {
  let body = cloudTarget(particle, input)
  if (input.cosmicMode) body = cosmicModeTarget(particle, body, input)
  const mode = resolveNyxusMode(input)

  if (mode === 'dragging') return draggingTarget(particle, body, input)
  if (mode === 'released') return releasedTarget(particle, body, input)
  if (mode === 'menu') return menuTarget(particle, body, input)
  if (mode === 'reach') return reachTarget(particle, body, input)
  if (mode === 'cosmic') return body

  if (mode === 'working') {
    const angle = Math.atan2(body.y, body.x) + input.time * 0.025 * particle.orbit
    const distance =
      Math.hypot(body.x, body.y) * (0.96 + Math.sin(input.time + particle.phase) * 0.035)
    body = { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance }
  } else if (mode === 'reaction') {
    const wave =
      Math.sin(input.actionAge * 3.2 - particle.radius * 5) * Math.exp(-input.actionAge * 0.85)
    body = { x: body.x * (1 - wave * 0.1), y: body.y * (1 - wave * 0.1) }
  } else if (mode === 'sleep') {
    body = { x: body.x * 1.18, y: body.y * 0.76 + input.size * 0.05 }
  }

  if (input.bootProgress < 1) {
    const boot = smoothstep(0, 1, input.bootProgress)
    return { x: body.x * boot, y: body.y * boot }
  }
  return body
}

/**
 * 恒星生灭状态机:
 * 1) 稳定恒星随机进入爆发，径向渐隐后消逝为普通点。
 * 2) 每个消逝位置晋升一个普通点，经历渐生后成为新恒星（总数恒定）。
 * 3) 新星重新分配鲜艳光晕色；核心始终纯白，生命周期更容易辨识。
 */
function stepNyxusExplosions(particles: NyxusParticle[], dt: number): void {
  const demoted: Array<{ particle: NyxusParticle; wasSpark: boolean }> = []
  for (const particle of particles) {
    if (particle.explosionT <= 0) continue
    particle.explosionT += dt / EXPLOSION_DURATION
    if (particle.explosionT >= 1) {
      const wasSpark = particle.brightness >= 3
      particle.explosionT = 0
      particle.brightness = wasSpark ? 1 : 0
      demoted.push({ particle, wasSpark })
    }
  }
  if (demoted.length > 0) {
    const promoted = new Set<NyxusParticle>(demoted.map((entry) => entry.particle))
    for (const { wasSpark } of demoted) {
      const candidates = particles.filter(
        (candidate) => !promoted.has(candidate) && candidate.brightness < 2,
      )
      if (candidates.length === 0) break
      const pick = candidates[Math.floor(Math.random() * candidates.length)]!
      pick.brightness = wasSpark ? 3 : 2
      pick.starColor = Math.floor(Math.random() * STAR_HALO_COLORS.length)
      pick.birthT = 1e-4 // 渐入:白点缓慢生长为恒星,对称寂灭渐隐
      promoted.add(pick)
    }
  }
  // 推进生长渐入(birthT 0→1)
  for (const particle of particles) {
    if (particle.birthT <= 0 || particle.birthT >= 1) continue
    particle.birthT += dt / BIRTH_DURATION
    if (particle.birthT >= 1) particle.birthT = 1
  }
  for (const particle of particles) {
    if (particle.brightness < 2 || particle.explosionT > 0) continue
    if (Math.random() < EXPLOSION_RATE * dt) particle.explosionT = 1e-4
  }
}

export function stepNyxusParticles(
  particles: NyxusParticle[],
  input: NyxusParticleInput,
  dt: number,
): void {
  const boundedDt = Math.min(dt, 1 / 30)
  const mode = resolveNyxusMode(input)
  const stiffness = mode === 'dragging' ? 2.2 : mode === 'menu' || mode === 'reach' ? 1.35 : 0.72
  const drag = mode === 'dragging' ? 2.2 : 1.15
  const damping = Math.exp(-drag * boundedDt)

  for (const particle of particles) {
    const target = particleTarget(particle, input)
    let ax = (target.x - particle.x) * stiffness
    let ay = (target.y - particle.y) * stiffness
    const targetDistance = Math.max(1, Math.hypot(target.x, target.y))
    const orbitForce = (1 - particle.radius * 0.55) * particle.orbit * 0.42
    ax += (-target.y / targetDistance) * orbitForce
    ay += (target.x / targetDistance) * orbitForce
    ax += Math.sin(input.time * 0.31 + particle.phase) * 0.24
    ay += Math.cos(input.time * 0.27 + particle.phase * 1.4) * 0.24

    if (input.swipeStrength > 0 && mode !== 'dragging') {
      const distanceFromPointer = Math.hypot(
        particle.x - input.pointer.x,
        particle.y - input.pointer.y,
      )
      const proximity = 1 - clamp(distanceFromPointer / input.size, 0, 1)
      ax += input.swipe.x * input.swipeStrength * proximity * 0.004
      ay += input.swipe.y * input.swipeStrength * proximity * 0.004
    }

    particle.vx = (particle.vx + ax * boundedDt) * damping
    particle.vy = (particle.vy + ay * boundedDt) * damping
    particle.x += particle.vx * boundedDt
    particle.y += particle.vy * boundedDt
  }

  const highlights = particles.filter((particle) => particle.brightness >= 2)
  const minimumDistance = Math.max(2.2, (input.size / 112) * 3)
  for (let leftIndex = 0; leftIndex < highlights.length; leftIndex += 1) {
    const left = highlights[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < highlights.length; rightIndex += 1) {
      const right = highlights[rightIndex]!
      let dx = right.x - left.x
      let dy = right.y - left.y
      let distance = Math.hypot(dx, dy)
      if (distance >= minimumDistance) continue
      if (distance < 0.001) {
        const angle = left.phase - right.phase
        dx = Math.cos(angle)
        dy = Math.sin(angle)
        distance = 0
      }
      const correction = (minimumDistance - distance) / 2
      const directionLength = Math.max(0.001, Math.hypot(dx, dy))
      const nx = dx / directionLength
      const ny = dy / directionLength
      left.x -= nx * correction
      left.y -= ny * correction
      right.x += nx * correction
      right.y += ny * correction
      left.vx -= nx * correction * 0.4
      left.vy -= ny * correction * 0.4
      right.vx += nx * correction * 0.4
      right.vy += ny * correction * 0.4
    }
  }

  stepNyxusExplosions(particles, boundedDt)
}

export function kickNyxusParticles(
  particles: NyxusParticle[],
  strength: number,
  inward = false,
): void {
  for (const particle of particles) {
    const distance = Math.max(1, Math.hypot(particle.x, particle.y))
    const direction = inward ? -1 : 1
    const impulse = strength * direction * (0.2 + particle.radius * 0.6)
    particle.vx += (particle.x / distance) * impulse
    particle.vy += (particle.y / distance) * impulse
  }
}
