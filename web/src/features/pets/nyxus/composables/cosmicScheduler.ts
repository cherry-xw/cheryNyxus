import {
  cosmicModeDuration,
  type NyxusCosmicMode,
  type NyxusServiceState,
} from '../particles/nyxusParticleEngine'

const STRUCTURAL_MODES = ['barredSpiral', 'inclinedDisk', 'singleRing', 'multiRing'] as const
const EVENT_MODES = ['starburst'] as const
const DUAL_MODES = ['binary', 'merger'] as const

export const NYXUS_IDLE_COSMIC_MODES: readonly NyxusCosmicMode[] = [
  ...STRUCTURAL_MODES,
  ...EVENT_MODES,
  ...DUAL_MODES,
]

export interface NyxusCosmicScheduleResult {
  mode: NyxusCosmicMode | null
  progress: number
}

/** 系统状态只保留断连黑洞与运行中脉冲星，且断连优先。 */
export function nyxusForcedCosmicState(
  serviceState: NyxusServiceState,
  working: boolean,
): NyxusCosmicScheduleResult | null {
  if (serviceState === 'disconnected') return { mode: 'blackHole', progress: 0.5 }
  if (working) return { mode: 'pulsar', progress: 0.5 }
  return null
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const current = result[index]!
    result[index] = result[swapIndex]!
    result[swapIndex] = current
  }
  return result
}

/**
 * 一袋恰好覆盖七种 idle 形态。单环/多环与其他结构形态同等参与；脉冲星
 * 专用于 Loading，不进入此袋。两个双星形态之间始终隔着其他形态。
 */
export function createNyxusCosmicModeBag(
  random: () => number = Math.random,
  previousMode: NyxusCosmicMode | null = null,
): NyxusCosmicMode[] {
  const structural = shuffle(STRUCTURAL_MODES, random)
  const ordinaryEvents = shuffle(EVENT_MODES, random)
  const dualEvents = shuffle(DUAL_MODES, random)
  const events: NyxusCosmicMode[] = [dualEvents[0]!, ordinaryEvents[0]!, dualEvents[1]!]
  const structuralFirst = random() < 0.5
  const bag: NyxusCosmicMode[] = structuralFirst
    ? [
        structural[0]!,
        events[0]!,
        structural[1]!,
        events[1]!,
        structural[2]!,
        events[2]!,
        structural[3]!,
      ]
    : [
        events[0]!,
        structural[0]!,
        events[1]!,
        structural[1]!,
        events[2]!,
        structural[2]!,
        structural[3]!,
      ]

  const isDual = (mode: NyxusCosmicMode | null) => mode === 'binary' || mode === 'merger'
  if (bag[0] === previousMode || (isDual(previousMode) && isDual(bag[0]!))) {
    for (let swapIndex = 1; swapIndex < bag.length; swapIndex += 1) {
      const candidate = [...bag]
      const first = candidate[0]!
      candidate[0] = candidate[swapIndex]!
      candidate[swapIndex] = first
      const hasAdjacentDual = candidate.some(
        (mode, index) => index > 0 && isDual(mode) && isDual(candidate[index - 1]!),
      )
      const crossesBagWithDual = isDual(previousMode) && isDual(candidate[0]!)
      if (candidate[0] !== previousMode && !crossesBagWithDual && !hasAdjacentDual) return candidate
    }
  }
  return bag
}

export function createNyxusCosmicScheduler(random: () => number = Math.random) {
  let activeMode: NyxusCosmicMode | null = null
  let activeStartedAt = 0
  let pausedAt: number | null = null
  let previousMode: NyxusCosmicMode | null = null
  let nextModeAt = Number.POSITIVE_INFINITY
  let bag: NyxusCosmicMode[] = []
  let cancelled = false

  function randomDelay(reducedMotion: boolean): number {
    const base = 12000 + random() * 12000
    return reducedMotion ? base * 2.2 : base
  }

  function initialize(now: number, reducedMotion: boolean): void {
    cancelled = false
    nextModeAt = now + randomDelay(reducedMotion)
  }

  function cancel(now: number, reducedMotion: boolean): void {
    if (cancelled) return
    if (activeMode) previousMode = activeMode
    activeMode = null
    pausedAt = null
    bag = []
    cancelled = true
    nextModeAt = now + randomDelay(reducedMotion)
  }

  function update(
    now: number,
    eligible: boolean,
    blockStart: boolean,
    reducedMotion: boolean,
  ): NyxusCosmicScheduleResult {
    cancelled = false
    if (activeMode) {
      if (!eligible) {
        pausedAt ??= now
        return { mode: null, progress: 0 }
      }
      if (pausedAt !== null) {
        activeStartedAt += now - pausedAt
        pausedAt = null
      }
      const elapsed = (now - activeStartedAt) / 1000
      const duration = cosmicModeDuration(activeMode)
      if (elapsed < duration) return { mode: activeMode, progress: elapsed / duration }
      previousMode = activeMode
      activeMode = null
      nextModeAt = now + randomDelay(reducedMotion)
    }

    if (!eligible) {
      nextModeAt = Math.max(nextModeAt, now + 2500)
      return { mode: null, progress: 0 }
    }
    if (blockStart || now < nextModeAt) return { mode: null, progress: 0 }

    if (bag.length === 0) bag = createNyxusCosmicModeBag(random, previousMode)
    activeMode = bag.shift() ?? 'barredSpiral'
    activeStartedAt = now
    return { mode: activeMode, progress: 0 }
  }

  return { initialize, cancel, update }
}
