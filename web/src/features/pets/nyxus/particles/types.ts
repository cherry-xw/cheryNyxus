import type { PetAction, PetMood } from '@/features/pets/types/types'

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
