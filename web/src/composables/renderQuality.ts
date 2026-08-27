import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue'

export type RenderQualityTier = 'high' | 'balanced' | 'low'

export interface RenderQualityProfile {
  tier: RenderQualityTier
  particleCountAt112: number
  particleDpr: number
  particleIdleFps: number
  particleActiveFps: number
  particleAtmosphereFps: number
  graphDpr: number
  graphLabelResolution: number
  graphMotionFps: number
}

export const RENDER_QUALITY_PROFILES: Readonly<Record<RenderQualityTier, RenderQualityProfile>> = {
  high: {
    tier: 'high',
    particleCountAt112: 500,
    particleDpr: 2,
    particleIdleFps: 45,
    particleActiveFps: 45,
    particleAtmosphereFps: 20,
    graphDpr: 2,
    graphLabelResolution: 2,
    graphMotionFps: 30,
  },
  balanced: {
    tier: 'balanced',
    particleCountAt112: 360,
    particleDpr: 1.5,
    particleIdleFps: 30,
    particleActiveFps: 45,
    particleAtmosphereFps: 15,
    graphDpr: 1.5,
    graphLabelResolution: 1.5,
    graphMotionFps: 24,
  },
  low: {
    tier: 'low',
    particleCountAt112: 220,
    particleDpr: 1,
    particleIdleFps: 20,
    particleActiveFps: 24,
    particleAtmosphereFps: 10,
    graphDpr: 1,
    graphLabelResolution: 1,
    graphMotionFps: 18,
  },
}

export function renderQualityProfile(tier: RenderQualityTier): RenderQualityProfile {
  return RENDER_QUALITY_PROFILES[tier]
}

export function particleCountForSize(size: number, tier: RenderQualityTier): number {
  const target = renderQualityProfile(tier).particleCountAt112 * (size / 112)
  return Math.round(Math.min(500, Math.max(160, target)))
}

export interface AdaptiveQualityGovernor {
  readonly tier: RenderQualityTier
  recordFrame(intervalMs: number, now?: number): RenderQualityTier
  reset(tier?: RenderQualityTier): void
}

interface FrameSample {
  at: number
  intervalMs: number
}

const DOWNGRADE_WINDOW_MS = 3_000
const UPGRADE_WINDOW_MS = 10_000
const DOWNGRADE_P95_MS = 22
const UPGRADE_P95_MS = 14
const MIN_DOWNGRADE_SAMPLES = 45
const MIN_UPGRADE_SAMPLES = 180

function percentile95(samples: readonly FrameSample[], since: number): number {
  const values = samples
    .filter((sample) => sample.at >= since)
    .map((sample) => sample.intervalMs)
    .sort((left, right) => left - right)
  if (!values.length) return 0
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.95))]!
}

function sampleCount(samples: readonly FrameSample[], since: number): number {
  let count = 0
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index]!.at < since) break
    count += 1
  }
  return count
}

function lowerTier(tier: RenderQualityTier): RenderQualityTier {
  return tier === 'high' ? 'balanced' : 'low'
}

function higherTier(tier: RenderQualityTier): RenderQualityTier {
  return tier === 'low' ? 'balanced' : 'high'
}

/**
 * Hysteretic frame-time governor shared by Canvas2D and Pixi.
 *
 * It consumes display RAF intervals rather than a deliberately throttled renderer's
 * presentation cadence, so running a decorative layer at 30 Hz does not look like a
 * permanently overloaded 30 FPS display.
 */
export function createAdaptiveQualityGovernor(
  initialTier: RenderQualityTier = 'balanced',
): AdaptiveQualityGovernor {
  let currentTier = initialTier
  let samples: FrameSample[] = []
  let lastTransitionAt: number | undefined

  return {
    get tier() {
      return currentTier
    },
    recordFrame(intervalMs: number, now = performance.now()) {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) return currentTier
      lastTransitionAt ??= now
      // 后台恢复由调用方过滤；真正的长帧应计入压力，而不是因过慢被忽略。
      samples.push({ at: now, intervalMs: Math.min(intervalMs, 250) })
      const oldest = now - UPGRADE_WINDOW_MS
      const firstLive = samples.findIndex((sample) => sample.at >= oldest)
      if (firstLive > 0) samples = samples.slice(firstLive)

      const downgradeSince = now - DOWNGRADE_WINDOW_MS
      if (
        currentTier !== 'low' &&
        now - lastTransitionAt >= DOWNGRADE_WINDOW_MS &&
        sampleCount(samples, downgradeSince) >= MIN_DOWNGRADE_SAMPLES &&
        percentile95(samples, downgradeSince) > DOWNGRADE_P95_MS
      ) {
        currentTier = lowerTier(currentTier)
        lastTransitionAt = now
        samples = samples.filter((sample) => sample.at >= downgradeSince)
        return currentTier
      }

      if (
        currentTier !== 'high' &&
        now - lastTransitionAt >= UPGRADE_WINDOW_MS &&
        sampleCount(samples, oldest) >= MIN_UPGRADE_SAMPLES &&
        percentile95(samples, oldest) < UPGRADE_P95_MS
      ) {
        currentTier = higherTier(currentTier)
        lastTransitionAt = now
        samples = []
      }
      return currentTier
    },
    reset(tier = initialTier) {
      currentTier = tier
      samples = []
      lastTransitionAt = undefined
    },
  }
}

const adaptiveGovernor = createAdaptiveQualityGovernor()
const adaptiveTier = ref<RenderQualityTier>(adaptiveGovernor.tier)

export const renderQualityTier = readonly(adaptiveTier)
export const currentRenderQuality = computed(() => renderQualityProfile(adaptiveTier.value))

export function reportDisplayFrame(intervalMs: number, now = performance.now()): void {
  if (typeof document !== 'undefined' && document.hidden) return
  const next = adaptiveGovernor.recordFrame(intervalMs, now)
  if (adaptiveTier.value !== next) adaptiveTier.value = next
}

export interface RenderQualityState {
  tier: Readonly<Ref<RenderQualityTier>>
  profile: ComputedRef<RenderQualityProfile>
}

export function useRenderQuality(): RenderQualityState {
  return { tier: renderQualityTier, profile: currentRenderQuality }
}

/** Test and diagnostics escape hatch; production behavior always starts balanced. */
export function resetAdaptiveRenderQuality(tier: RenderQualityTier = 'balanced'): void {
  adaptiveGovernor.reset(tier)
  adaptiveTier.value = tier
}
