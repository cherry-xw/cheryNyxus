import type { PetAction, PetMood } from '@/domain/pets/types'

export interface Vec2 {
  x: number
  y: number
}

/** 普通 Pet 仅以只读视觉关联进入 Nyxus；坐标相对 Nyxus 核心。 */
export interface NyxusNearbyPet {
  position: Vec2
  distance: number
  color: string
}

export type NyxusReaction = 'positive' | 'agitated' | 'error'

/** 服务连接驱动的系统呈现态；只有 disconnected 会渲染黑洞。 */
export type NyxusServiceState = 'connected' | 'connecting' | 'disconnected'

/**
 * 保留 cosmicMode 名称以兼容现有渲染数据属性；blackHole 不再由 idle 调度选择，
 * 仅用于 disconnected 的服务呈现态。
 */
export type NyxusCosmicMode =
  | 'blackHole'
  | 'pulsar'
  | 'binary'
  | 'supernova'
  | 'tidalRings'
  | 'singleRing'
  | 'multiRing'
  | 'barredSpiral'
  | 'inclinedDisk'
  | 'merger'
  | 'starburst'

export type NyxusRenderMode =
  'dragging' | 'released' | 'menu' | 'reach' | 'reaction' | 'cosmic' | 'sleep' | 'idle'

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
  serviceState: NyxusServiceState
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
  /** 同向绕行累积的旋臂相位，只作局部、缓慢且可衰减的偏移。 */
  armPhaseOffset: number
  /** 快速掠过留下的短暂潮汐尘埃尾，方向指向尾端。 */
  tidalTailDirection: Vec2
  tidalTailStrength: number
  /** 在旋臂静止停留后形成的低亮结；生命周期完全由输入侧计时。 */
  starFormationPoint: Vec2 | null
  starFormationStrength: number
  /** 安全距离外的最近普通 Pet；只供渲染，不参与运动或交互。 */
  nearbyPet: NyxusNearbyPet | null
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
