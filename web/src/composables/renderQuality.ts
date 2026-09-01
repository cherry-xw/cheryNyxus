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
  desktopNoiseOpacity: number
  windowGlitchPixels: number
  graphPulseSegments: number
  graphEffectNodes: number
}

export const RENDER_QUALITY_PROFILES: Readonly<Record<RenderQualityTier, RenderQualityProfile>> = {
  high: {
    tier: 'high',
    particleCountAt112: 420,
    particleDpr: 1.75,
    particleIdleFps: 45,
    particleActiveFps: 45,
    particleAtmosphereFps: 20,
    graphDpr: 1.75,
    graphLabelResolution: 1.75,
    graphMotionFps: 30,
    desktopNoiseOpacity: 0.2,
    windowGlitchPixels: 5,
    graphPulseSegments: 7,
    graphEffectNodes: 48,
  },
  balanced: {
    tier: 'balanced',
    particleCountAt112: 300,
    particleDpr: 1.25,
    particleIdleFps: 30,
    particleActiveFps: 45,
    particleAtmosphereFps: 15,
    graphDpr: 1.25,
    graphLabelResolution: 1.25,
    graphMotionFps: 24,
    desktopNoiseOpacity: 0.12,
    windowGlitchPixels: 3,
    graphPulseSegments: 5,
    graphEffectNodes: 28,
  },
  low: {
    tier: 'low',
    particleCountAt112: 180,
    particleDpr: 1,
    particleIdleFps: 20,
    particleActiveFps: 24,
    particleAtmosphereFps: 10,
    graphDpr: 1,
    graphLabelResolution: 1,
    graphMotionFps: 18,
    desktopNoiseOpacity: 0.04,
    windowGlitchPixels: 1,
    graphPulseSegments: 3,
    graphEffectNodes: 12,
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
const LOW_DOWNGRADE_WINDOW_MS = 2_000
const BALANCED_UPGRADE_WINDOW_MS = 10_000
const HIGH_UPGRADE_WINDOW_MS = 12_000
const HIGH_DOWNGRADE_P95_MS = 24
const LOW_DOWNGRADE_P95_MS = 33
const BALANCED_UPGRADE_P95_MS = 20
const HIGH_UPGRADE_P95_MS = 18.5
const MAX_SAMPLE_WINDOW_MS = HIGH_UPGRADE_WINDOW_MS

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
      const oldest = now - MAX_SAMPLE_WINDOW_MS
      const firstLive = samples.findIndex((sample) => sample.at >= oldest)
      if (firstLive > 0) samples = samples.slice(firstLive)

      const downgradeWindow = currentTier === 'balanced' ? LOW_DOWNGRADE_WINDOW_MS : DOWNGRADE_WINDOW_MS
      const downgradeSince = now - downgradeWindow
      const downgradeThreshold =
        currentTier === 'balanced' ? LOW_DOWNGRADE_P95_MS : HIGH_DOWNGRADE_P95_MS
      const minimumDowngradeSamples = Math.max(30, Math.floor(downgradeWindow / 34))
      if (currentTier !== 'low' && now - lastTransitionAt >= downgradeWindow &&
        sampleCount(samples, downgradeSince) >= minimumDowngradeSamples &&
        percentile95(samples, downgradeSince) > downgradeThreshold) {
        currentTier = lowerTier(currentTier)
        lastTransitionAt = now
        samples = samples.filter((sample) => sample.at >= downgradeSince)
        return currentTier
      }

      const upgradeWindow = currentTier === 'low' ? BALANCED_UPGRADE_WINDOW_MS : HIGH_UPGRADE_WINDOW_MS
      const upgradeSince = now - upgradeWindow
      const upgradeThreshold =
        currentTier === 'low' ? BALANCED_UPGRADE_P95_MS : HIGH_UPGRADE_P95_MS
      const minimumUpgradeSamples = Math.floor(upgradeWindow / 34)
      if (currentTier !== 'high' && now - lastTransitionAt >= upgradeWindow &&
        sampleCount(samples, upgradeSince) >= minimumUpgradeSamples &&
        percentile95(samples, upgradeSince) <= upgradeThreshold) {
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
