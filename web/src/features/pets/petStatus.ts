import type { PetInstance, PetMood } from './types'

/**
 * pet 状态数值算法（纯函数，不依赖 reactive）。
 *
 * 与 usePetWorld 的状态机分离：usePetWorld 管 action 状态机（sleep/hover/chatting
 * 转移、交互事件），petStatus 负责"emotion/fatigue 这一帧怎么变"——衰减/恢复/累积
 * 的纯数值计算 + 状态→mood 映射 + 休息/唤醒谓词。
 *
 * 数值可调项集中为 StatusConfig（速率/阈值/交互增量），DEFAULT_STATUS_CONFIG 为默认，
 * resolveStatus(overrides?) 合并覆盖。对齐 petMovement.ts 的 MovementOptions 惯例。
 */

export interface StatusConfig {
  /** emotion 初始值。 */
  emotionInit?: number
  /** emotion 每秒缓降（active 态）。 */
  emotionDecay?: number
  /** emotion 每秒恢复（sleep 态）。 */
  emotionRecover?: number
  /** fatigue 移动每秒累积（walk 态，由 usePetWorld 走位分支调用 adjustFatigue）。 */
  fatigueWalkRate?: number
  /** fatigue 每次聊天累积（离散增量）。 */
  fatigueChat?: number
  /** fatigue 自动休息阈值（≥ → sleep）。 */
  fatigueSleep?: number
  /** fatigue 自然醒阈值（≤ → wake）。 */
  fatigueWake?: number
  /** fatigue 每秒恢复（sleep 态）。 */
  fatigueRecover?: number
  // --- emotion 交互增量 ---
  emoteClick?: number
  emoteRapid?: number
  emoteDrag?: number
  emoteHover?: number
  emoteDisturb?: number
  emoteFeed?: number
  emotePet?: number
  emotePunch?: number
}

export const DEFAULT_STATUS_CONFIG: Required<StatusConfig> = {
  emotionInit: 70,
  emotionDecay: 0.6,
  emotionRecover: 4,
  fatigueWalkRate: 1.2,
  fatigueChat: 8,
  fatigueSleep: 80,
  fatigueWake: 10,
  fatigueRecover: 12,
  emoteClick: 6,
  emoteRapid: -8,
  emoteDrag: -3,
  emoteHover: 1,
  emoteDisturb: -5,
  emoteFeed: 15,
  emotePet: 8,
  emotePunch: -10,
}

/** 合并覆盖：overrides 覆盖默认值，返回完整 config。 */
export function resolveStatus(overrides?: StatusConfig): Required<StatusConfig> {
  return { ...DEFAULT_STATUS_CONFIG, ...(overrides ?? {}) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** emotion += delta，clamp(0,100)。 */
export function adjustEmotion(pet: PetInstance, delta: number): void {
  pet.emotion = clamp(pet.emotion + delta, 0, 100)
}

/** fatigue += delta，clamp(0,100)。 */
export function adjustFatigue(pet: PetInstance, delta: number): void {
  pet.fatigue = clamp(pet.fatigue + delta, 0, 100)
}

/**
 * 基础 mood：状态驱动（临时 mood 到期后回落）。按优先级：
 * sleep/疲劳≥阈值 → sleepy；emotion<25 → sad；emotion<50 → calm；isMaster → serious；默认 calm。
 */
export function restMood(pet: PetInstance, config?: StatusConfig): PetMood {
  const cfg = resolveStatus(config)
  if (pet.action === 'sleep' || pet.fatigue >= cfg.fatigueSleep) return 'sleepy'
  if (pet.emotion < 25) return 'sad'
  if (pet.emotion < 50) return 'calm'
  return pet.isMaster ? 'serious' : 'calm'
}

/**
 * 一帧状态数值更新（被动漂移）：
 * - sleep：fatigue↓(recover) + emotion↑(recover)
 * - active（调用方已跳过 hover/dragging）：emotion↓(decay)
 * walk-fatigue 累积与移动耦合，由 usePetWorld 走位分支调
 * adjustFatigue(pet, cfg.fatigueWalkRate * dt)。
 */
export function stepVitals(pet: PetInstance, dt: number, config?: StatusConfig): void {
  const cfg = resolveStatus(config)
  if (pet.action === 'sleep') {
    adjustFatigue(pet, -cfg.fatigueRecover * dt)
    adjustEmotion(pet, cfg.emotionRecover * dt)
    return
  }
  adjustEmotion(pet, -cfg.emotionDecay * dt)
}

/** 自动休息判定：fatigue ≥ 阈值。 */
export function shouldSleep(pet: PetInstance, config?: StatusConfig): boolean {
  return pet.fatigue >= resolveStatus(config).fatigueSleep
}

/** 自然醒判定：fatigue ≤ 阈值。 */
export function shouldWake(pet: PetInstance, config?: StatusConfig): boolean {
  return pet.fatigue <= resolveStatus(config).fatigueWake
}
