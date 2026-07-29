import { clamp, smoothstep, TAU, mixAngle } from './math'
import { nyxusCosmicTransitionStrength } from './tone'
import type { NyxusParticle, NyxusParticleInput, Vec2, NyxusRenderMode } from './types'

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
