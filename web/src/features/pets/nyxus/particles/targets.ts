import { clamp, smoothstep, TAU, mixAngle } from './math'
import { nyxusCosmicTransitionStrength } from './tone'
import type { NyxusParticle, NyxusParticleInput, Vec2, NyxusRenderMode } from './types'

export function resolveNyxusMode(input: NyxusParticleInput): NyxusRenderMode {
  if (input.serviceState === 'disconnected') return 'cosmic'
  if (input.action === 'dragging') return 'dragging'
  if (input.releaseStrength > 0.035) return 'released'
  if (input.menuOpen && input.menuTargets.length > 0) return 'menu'
  if (input.working && input.cosmicMode) return 'cosmic'
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
  const armBranch = Math.floor(particle.galaxyArm / 2)
  const branchDirection = armBranch === 1 ? 1 : armBranch === 2 ? -1 : 0
  const branchSpread =
    branchDirection * smoothstep(0.46, 0.94, particle.radius) * (0.38 + armBranch * 0.08)
  const armAngle =
    (particle.galaxyArm % 2) * Math.PI +
    -particle.radius * 4.45 +
    branchSpread +
    input.time * armPatternSpeed +
    // 绕圈只推进外盘旋臂相位，核心仍稳定，且 input 侧会在数秒内回落。
    input.armPhaseOffset * smoothstep(0.18, 0.88, particle.radius) +
    particle.noise * (armBranch === 0 ? 0.075 : 0.115) +
    (particle.armRank - 0.5) * (armBranch === 0 ? 0.12 : 0.18) +
    Math.sin(particle.phase * 0.7) * 0.035
  const armStrength =
    smoothstep(0.12, 0.58, particle.radius) *
    (armBranch === 0 ? 0.98 : 0.88) *
    (0.94 + (1 - particle.armRank) * 0.05)
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

/** 短暖棒核连接两条主旋臂；保留基础盘面的缓慢进动，避免形态停滞成图标。 */
function barredSpiralTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const tilt = input.time * 0.028 + Math.sin(input.time * 0.09) * 0.14
  const barStrength = 1 - smoothstep(0.14, 0.42, particle.radius)
  const bar = rotatePoint(
    {
      x: particle.noise * input.size * (0.045 + particle.radius * 0.52),
      y: Math.sin(particle.phase * 2.3) * input.size * 0.028,
    },
    tilt,
  )
  const armLift = rotatePoint(body, tilt * 0.35)
  return blendPoint(armLift, bar, barStrength * (0.72 + (1 - particle.armRank) * 0.2))
}

/** 倾斜盘以窄而有厚度的冷色盘面呈现，中心核球保持更圆，留出暗尘带的视觉空间。 */
function inclinedDiskTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const tilt = 0.7 + Math.sin(input.time * 0.055) * 0.24
  const local = rotatePoint(body, -tilt)
  const nucleus = 1 - smoothstep(0.08, 0.3, particle.radius)
  const diskThickness = 0.3 + nucleus * 0.6
  const dustLaneOffset =
    particle.radius > 0.26 && particle.armRank > 0.5
      ? Math.sign(Math.sin(particle.phase * 1.7)) * input.size * 0.012
      : 0
  return rotatePoint({ x: local.x * 1.08, y: local.y * diskThickness + dustLaneOffset }, tilt)
}

/** 单环/多环是完整 idle 星系目标场，不再由运行状态临时叠加线框。 */
function ringGalaxyTarget(
  particle: NyxusParticle,
  body: Vec2,
  input: NyxusParticleInput,
  ringCount: 1 | 3,
): Vec2 {
  const nucleus = 1 - smoothstep(0.06, 0.2, particle.radius)
  const ringIndex = ringCount === 1 ? 0 : particle.armSlot % ringCount
  const baseRadius = ringCount === 1 ? 0.31 : 0.18 + ringIndex * 0.105
  const thickness = particle.noise * input.size * (ringCount === 1 ? 0.022 : 0.016)
  const radius = input.size * baseRadius + thickness
  const direction = ringIndex % 2 === 0 ? 1 : -1
  const angle =
    particle.angle +
    input.time * direction * (0.09 + particle.orbit * 0.025 + ringIndex * 0.012) +
    particle.phase * 0.055
  const tilt =
    input.time * (0.018 + ringIndex * 0.006) +
    (ringCount === 1 ? 0.42 : 0.18 + ringIndex * 0.62)
  const flattening = ringCount === 1 ? 0.52 : 0.48 + ringIndex * 0.09
  const ring = rotatePoint(
    { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius * flattening },
    tilt,
  )
  const nucleusPoint = { x: body.x * 0.38, y: body.y * 0.38 }
  return blendPoint(ring, nucleusPoint, nucleus)
}

export interface NyxusBinaryGeometry {
  centers: [Vec2, Vec2]
  displayCenters: [Vec2, Vec2]
  coreScales: [number, number]
  dualStrength: number
  displayStrength: number
  bridgeStrength: number
}

/** 单盘裂变、双核互绕和再次融合共享的几何，目标场与渲染核心必须共同消费。 */
export function nyxusBinaryGeometry(input: NyxusParticleInput): NyxusBinaryGeometry {
  const progress = clamp(input.cosmicProgress, 0, 1)
  const split = smoothstep(0.1, 0.34, progress)
  const fuse = 1 - smoothstep(0.66, 0.92, progress)
  const dualStrength = split * fuse
  const orbit = smoothstep(0.28, 0.58, progress) * (1 - smoothstep(0.66, 0.86, progress))
  const separation = input.size * 0.205 * dualStrength * (1 + Math.sin(input.time * 0.16) * 0.035)
  const axis = input.time * 0.055 + orbit * 0.72 + Math.sin(input.time * 0.035) * 0.16
  const verticalOffset = input.size * 0.032 * dualStrength
  const centers: [Vec2, Vec2] = [
    rotatePoint({ x: -separation, y: -verticalOffset }, axis),
    rotatePoint({ x: separation, y: verticalOffset }, axis),
  ]
  const transitionStrength = nyxusCosmicTransitionStrength(progress)
  return {
    centers,
    displayCenters: [
      { x: centers[0].x * transitionStrength, y: centers[0].y * transitionStrength },
      { x: centers[1].x * transitionStrength, y: centers[1].y * transitionStrength },
    ],
    coreScales: [1, 0.82],
    dualStrength,
    displayStrength: dualStrength * transitionStrength,
    bridgeStrength:
      smoothstep(0.48, 0.68, progress) *
      (1 - smoothstep(0.78, 0.94, progress)) *
      dualStrength,
  }
}

function binaryTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const geometry = nyxusBinaryGeometry(input)
  const sideIndex = particle.galaxyArm % 2
  const side = sideIndex === 0 ? -1 : 1
  const center = geometry.centers[sideIndex]!
  const localRadius =
    input.size * (0.012 + particle.radius * 0.235) * geometry.coreScales[sideIndex]!
  const localArm = particle.phase < Math.PI ? 0 : 1
  const localAngle =
    localArm * Math.PI +
    particle.radius * 3.85 +
    input.time * (0.1 + particle.orbit * 0.025) * side +
    particle.noise * 0.12
  const localDisk = rotatePoint(
    {
      x: Math.cos(localAngle) * localRadius,
      y: Math.sin(localAngle) * localRadius * 0.7,
    },
    input.time * 0.055 + side * 0.18,
  )
  const galaxyPoint = { x: center.x + localDisk.x, y: center.y + localDisk.y }
  const bridgeRank = 1 - smoothstep(0.12, 0.31, particle.armRank)
  const bridge = curvePoint(
    geometry.centers[0],
    geometry.centers[1],
    particle.armT,
    Math.sin(particle.phase + input.time * 0.2) * input.size * 0.055,
  )
  const bridged = blendPoint(galaxyPoint, bridge, geometry.bridgeStrength * bridgeRank)
  return blendPoint(body, bridged, geometry.dualStrength)
}

/** 两个星系在一段模式周期内完成靠近、潮汐桥/尾、双核并合、局部星暴与再次拆分。 */
function mergerTarget(
  particle: NyxusParticle,
  body: Vec2,
  input: NyxusParticleInput,
): Vec2 {
  const progress = clamp(input.cosmicProgress, 0, 1)
  const approaching = 1 - smoothstep(0.08, 0.48, progress)
  const separating = smoothstep(0.64, 0.94, progress)
  const separation =
    input.size *
    (0.055 + (approaching + separating) * 0.2)
  const axis = input.time * 0.09 + Math.sin(input.time * 0.035) * 0.34
  const side = particle.galaxyArm % 2 === 0 ? 1 : -1
  const core = rotatePoint({ x: side * separation, y: side * input.size * 0.035 }, axis)
  const localAngle = particle.angle + side * 0.32 + input.time * (0.12 + particle.orbit * 0.035)
  const localRadius = input.size * (0.018 + particle.radius * 0.24)
  const localDisk = rotatePoint(
    {
      x: Math.cos(localAngle) * localRadius * 1.06,
      y: Math.sin(localAngle) * localRadius * 0.68,
    },
    axis + side * 0.18,
  )
  const galaxyPoint = { x: core.x + localDisk.x, y: core.y + localDisk.y }

  const bridgeAmount =
    smoothstep(0.14, 0.42, progress) * (1 - smoothstep(0.68, 0.88, progress))
  const bridgeRank = 1 - smoothstep(0.1, 0.34, particle.armRank)
  const bridge = curvePoint(
    rotatePoint({ x: -separation, y: -input.size * 0.035 }, axis),
    rotatePoint({ x: separation, y: input.size * 0.035 }, axis),
    particle.armT,
    Math.sin(particle.phase + input.time * 0.23) * input.size * 0.075,
  )
  const tailAmount =
    smoothstep(0.16, 0.5, progress) *
    (1 - smoothstep(0.72, 0.96, progress)) *
    smoothstep(0.55, 0.94, particle.radius)
  const tail = rotatePoint(
    {
      x: side * input.size * (0.18 + particle.radius * 0.3),
      y: Math.sin(particle.phase * 1.5) * input.size * (0.1 + particle.radius * 0.16),
    },
    axis - side * 0.78,
  )
  const burst = smoothstep(0.42, 0.62, progress) * (1 - smoothstep(0.7, 0.86, progress))
  const mergedBody = {
    x: body.x * (0.68 + particle.radius * 0.18),
    y: body.y * (0.68 + particle.radius * 0.18),
  }
  const mergedStarburst = {
    x: mergedBody.x + Math.cos(particle.phase * 2.1) * input.size * particle.radius * burst * 0.12,
    y: mergedBody.y + Math.sin(particle.phase * 2.1) * input.size * particle.radius * burst * 0.12,
  }
  const dual = blendPoint(galaxyPoint, bridge, bridgeAmount * bridgeRank)
  const tailed = blendPoint(dual, tail, tailAmount * (1 - bridgeRank) * 0.46)
  const mergeAmount = smoothstep(0.36, 0.58, progress) * (1 - smoothstep(0.72, 0.9, progress))
  return blendPoint(tailed, mergedStarburst, mergeAmount)
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

function cosmicModeTarget(particle: NyxusParticle, body: Vec2, input: NyxusParticleInput): Vec2 {
  const mode = input.cosmicMode
  if (!mode) return body
  const amount = nyxusCosmicTransitionStrength(input.cosmicProgress)
  let target = body
  if (mode === 'blackHole') target = blackHoleTarget(particle, input)
  else if (mode === 'pulsar') target = pulsarTarget(particle, input)
  else if (mode === 'binary') target = binaryTarget(particle, body, input)
  else if (mode === 'supernova') target = supernovaTarget(particle, body, input)
  else if (mode === 'tidalRings') target = ringGalaxyTarget(particle, body, input, 3)
  else if (mode === 'singleRing') target = ringGalaxyTarget(particle, body, input, 1)
  else if (mode === 'multiRing') target = ringGalaxyTarget(particle, body, input, 3)
  else if (mode === 'barredSpiral') target = barredSpiralTarget(particle, body, input)
  else if (mode === 'inclinedDisk') target = inclinedDiskTarget(particle, body, input)
  else if (mode === 'merger') target = mergerTarget(particle, body, input)
  else if (mode === 'starburst') target = supernovaTarget(particle, body, input)
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

  if (mode === 'reaction') {
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
