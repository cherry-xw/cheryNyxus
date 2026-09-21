import { TAU, mulberry32, clamp } from './math'
import { CLOUD_COLORS, STAR_HALO_COLORS } from './colors'
import { particleTarget, resolveNyxusMode } from './targets'
import type { NyxusParticle, NyxusParticleInput, NyxusCosmicMode, NyxusStarKind } from './types'

const HIGHLIGHT_RATIO = 0.02
const SPARK_RATIO = 0.003
const HIGHLIGHT_BASE_SPACING = 0.075
/** 恒星爆发与再生均放缓，让生灭循环能被看清。 */
const EXPLOSION_DURATION = 8
const EXPLOSION_RATE = 0.0015
const BIRTH_DURATION = 8

const COSMIC_MODE_DURATION: Record<NyxusCosmicMode, number> = {
  blackHole: 72,
  pulsar: 64,
  binary: 80,
  supernova: 64,
  tidalRings: 72,
  singleRing: 72,
  multiRing: 72,
  barredSpiral: 72,
  inclinedDisk: 72,
  merger: 80,
  starburst: 64,
}

export function createNyxusParticles(count: number, seed = 0x4e797875): NyxusParticle[] {
  const random = mulberry32(seed)
  const particles = Array.from({ length: count }, () => {
    const angle = random() * TAU
    const brightnessRoll = random()
    // 约三分之一外盘亮点点缀旋臂，让两条主旋臂在星云底色上清晰可见；其余为参与云团的暗点。
    const brightness = brightnessRoll > 0.67 ? 1 : 0
    const radius = Math.pow(random(), brightness === 0 ? 1.15 : 0.55)
    const initialDistance = radius * 46
    const x = Math.cos(angle) * initialDistance + (random() - 0.5) * 12
    const y = Math.sin(angle) * initialDistance + (random() - 0.5) * 12
    const armRoll = random()
    const galaxyArm =
      armRoll < 0.62
        ? Math.floor(random() * 2)
        : armRoll < 0.86
          ? 2 + Math.floor(random() * 2)
          : 4 + Math.floor(random() * 2)
    return {
      x,
      y,
      vx: (random() - 0.5) * 7,
      vy: (random() - 0.5) * 7,
      angle,
      radius,
      phase: random() * TAU,
      // 尺寸高次幂分布：绝大多数小星铺底，极少数大星点缀，形成有大有小的星场层次。
      size: 0.35 + Math.pow(random(), 4) * 1.45,
      brightness,
      colorCycle: 0,
      cloudColor: Math.floor(random() * CLOUD_COLORS.length),
      starColor: Math.floor(random() * STAR_HALO_COLORS.length),
      starKind: 'normal' as NyxusStarKind,
      armRank: random(),
      armT: random(),
      armSlot: Math.floor(random() * 3),
      // 0/1 是双主臂，2–5 是从外盘分出的两级弱支臂。
      galaxyArm,
      noise: random() * 2 - 1,
      orbit: 0.35 + random() * 0.9,
      explosionT: 0,
      birthT: 1,
      retireT: 1,
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
  for (const particle of particles) {
    if (particle.brightness < 2) continue
    const stableRoll = (((particle.phase / TAU) + particle.starColor * 0.17) % 1 + 1) % 1
    particle.starKind = stableRoll < 0.025 ? 'redGiant' : stableRoll < 0.105 ? 'bluePulsar' : 'normal'
  }
  return particles
}

export function cosmicModeDuration(mode: NyxusCosmicMode): number {
  return COSMIC_MODE_DURATION[mode]
}

/**
 * 恒星生灭状态机:
 * 1) 稳定恒星随机进入爆发，径向渐隐后消逝为普通点。
 * 2) 每个消逝位置晋升一个普通点，经历渐生后成为新恒星（总数恒定）。
 * 3) 新星重新分配鲜艳光晕色；核心始终纯白，生命周期更容易辨识。
 */
function stepNyxusExplosions(
  particles: NyxusParticle[],
  dt: number,
  allowReplacement = true,
): void {
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
  if (demoted.length > 0 && allowReplacement) {
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
    if (particle.retireT < 1) {
      particle.retireT = Math.max(0, particle.retireT - boundedDt / 1.2)
      continue
    }
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

  const minimumDistance = Math.max(2.2, (input.size / 112) * 3)
  for (let leftIndex = 0; leftIndex < particles.length; leftIndex += 1) {
    const left = particles[leftIndex]!
    if (left.brightness < 2) continue
    for (let rightIndex = leftIndex + 1; rightIndex < particles.length; rightIndex += 1) {
      const right = particles[rightIndex]!
      if (right.brightness < 2) continue
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

  stepNyxusExplosions(particles, boundedDt, particles.length <= (input.particleTarget ?? particles.length))
}

/** 追加正在渐生的粒子；用于连续提升数量，不重建已有星系。 */
export function appendNyxusParticles(particles: NyxusParticle[], count: number, seed: number): void {
  if (count <= 0) return
  const additions = createNyxusParticles(count, seed)
  for (const particle of additions) {
    particle.birthT = 0
    particle.retireT = 1
    particles.push(particle)
  }
}

/** 标记末端普通粒子进入湮灭，完成后由调用方移除。 */
export function retireNyxusParticles(particles: NyxusParticle[], count: number): void {
  let remaining = count
  for (let index = particles.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const particle = particles[index]!
    if (particle.retireT < 1 || particle.brightness >= 2) continue
    particle.retireT = 0.999
    remaining -= 1
  }
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

/**
 * 将外盘落点附近的一颗普通粒子晋升为新生恒星。
 * 保持总粒子数不变，并复用 stepNyxusExplosions 的出生—稳定—消亡周期。
 */
export function promoteNyxusParticleAt(
  particles: NyxusParticle[],
  point: { x: number; y: number },
): boolean {
  let selected: NyxusParticle | undefined
  let selectedDistance = Number.POSITIVE_INFINITY
  for (const particle of particles) {
    if (particle.brightness >= 2 || particle.explosionT > 0) continue
    const distance = Math.hypot(particle.x - point.x, particle.y - point.y)
    if (distance < selectedDistance) {
      selected = particle
      selectedDistance = distance
    }
  }
  if (!selected) return false
  selected.brightness = 2
  selected.birthT = 1e-4
  selected.explosionT = 0
  selected.starColor = Math.floor(Math.random() * STAR_HALO_COLORS.length)
  return true
}
