import { TAU, smoothstep, mixHexColor } from './math'
import type { NyxusParticle } from './types'

export const NYXUS_CHROMATIC_CYCLE_SECONDS = 84
const NYXUS_CHROMATIC_WINDOW = 0.032

export const CLOUD_COLORS = [
  '#a45cff',
  '#6d72ff',
  '#277cff',
  '#22d5ff',
  '#11d8c0',
  '#ff4fb4',
] as const
const COHESIVE_CLOUD_COLORS = ['#a45cff', '#786cff', '#4b83ff', '#2aaeff'] as const
export const STAR_HALO_COLORS = ['#a45cff', '#22d5ff', '#ff4fb4', '#4b83ff'] as const
const WHITE_STAR_CORE = '#ffffff'

export function contributesToNyxusFog(particle: NyxusParticle): boolean {
  return particle.brightness === 0 && particle.armRank >= 0.12 && particle.armRank <= 0.66
}

/** 由同一暗点层生成的星云云团色；缓慢跨越相邻色带，避免闪烁。 */
export function nyxusCloudColor(particle: NyxusParticle, time: number, cohesion = 0): string {
  const offset = particle.cloudColor + particle.phase / TAU
  const position =
    (((offset + time / 96) % CLOUD_COLORS.length) + CLOUD_COLORS.length) % CLOUD_COLORS.length
  const index = Math.floor(position)
  const next = (index + 1) % CLOUD_COLORS.length
  const individual = mixHexColor(
    CLOUD_COLORS[index]!,
    CLOUD_COLORS[next]!,
    smoothstep(0.16, 0.84, position - index),
  )
  const cohesivePosition =
    (((time / 120) % COHESIVE_CLOUD_COLORS.length) + COHESIVE_CLOUD_COLORS.length) %
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
