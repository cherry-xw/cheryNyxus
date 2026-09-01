import { describe, expect, it } from 'vitest'
import {
  RENDER_QUALITY_PROFILES,
  createAdaptiveQualityGovernor,
  particleCountForSize,
} from '../../src/composables/renderQuality'

describe('adaptive render quality', () => {
  it('downgrades quickly under sustained slow frames and upgrades conservatively', () => {
    const governor = createAdaptiveQualityGovernor('balanced')

    for (let now = 0; now <= 2_100; now += 16.67) governor.recordFrame(40, now)
    expect(governor.tier).toBe('low')

    for (let now = 2_110; now <= 12_200; now += 16.67) governor.recordFrame(16.67, now)
    expect(governor.tier).toBe('balanced')

    for (let now = 12_210; now <= 24_300; now += 16.67) governor.recordFrame(16.67, now)
    expect(governor.tier).toBe('high')
  })

  it('ignores invalid samples but counts real long frames as pressure', () => {
    const governor = createAdaptiveQualityGovernor()
    governor.recordFrame(0, 20_000)
    governor.recordFrame(Number.NaN, 20_100)
    expect(governor.tier).toBe('balanced')

    for (let now = 20_200; now <= 22_300; now += 34) governor.recordFrame(300, now)
    expect(governor.tier).toBe('low')
  })

  it('uses bounded resource budgets for every quality tier', () => {
    expect(RENDER_QUALITY_PROFILES.high).toMatchObject({
      particleCountAt112: 420,
      particleDpr: 1.75,
      graphDpr: 1.75,
      graphLabelResolution: 1.75,
    })
    expect(RENDER_QUALITY_PROFILES.balanced).toMatchObject({
      particleCountAt112: 300,
      particleDpr: 1.25,
      graphDpr: 1.25,
      graphLabelResolution: 1.25,
    })
    expect(RENDER_QUALITY_PROFILES.low).toMatchObject({
      particleCountAt112: 180,
      particleDpr: 1,
      graphDpr: 1,
      graphLabelResolution: 1,
    })
    expect(particleCountForSize(112, 'balanced')).toBe(300)
    expect(particleCountForSize(1_000, 'high')).toBe(500)
    expect(particleCountForSize(16, 'low')).toBe(160)
  })
})
