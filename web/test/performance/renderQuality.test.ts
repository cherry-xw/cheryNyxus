import { describe, expect, it } from 'vitest'
import {
  RENDER_QUALITY_PROFILES,
  createAdaptiveQualityGovernor,
  particleCountForSize,
} from '../../src/composables/renderQuality'

describe('adaptive render quality', () => {
  it('downgrades quickly under sustained slow frames and upgrades conservatively', () => {
    const governor = createAdaptiveQualityGovernor('balanced')

    for (let now = 0; now <= 3_000; now += 50) governor.recordFrame(30, now)
    expect(governor.tier).toBe('low')

    for (let now = 3_010; now <= 13_000; now += 10) governor.recordFrame(10, now)
    expect(governor.tier).toBe('balanced')

    for (let now = 13_010; now <= 23_000; now += 10) governor.recordFrame(10, now)
    expect(governor.tier).toBe('high')
  })

  it('ignores invalid samples but counts real long frames as pressure', () => {
    const governor = createAdaptiveQualityGovernor()
    governor.recordFrame(0, 20_000)
    governor.recordFrame(Number.NaN, 20_100)
    expect(governor.tier).toBe('balanced')

    for (let now = 20_200; now <= 23_200; now += 50) governor.recordFrame(300, now)
    expect(governor.tier).toBe('low')
  })

  it('uses bounded resource budgets for every quality tier', () => {
    expect(RENDER_QUALITY_PROFILES.high).toMatchObject({
      particleCountAt112: 500,
      particleDpr: 2,
      graphDpr: 2,
      graphLabelResolution: 2,
    })
    expect(RENDER_QUALITY_PROFILES.balanced).toMatchObject({
      particleCountAt112: 360,
      particleDpr: 1.5,
      graphDpr: 1.5,
      graphLabelResolution: 1.5,
    })
    expect(RENDER_QUALITY_PROFILES.low).toMatchObject({
      particleCountAt112: 220,
      particleDpr: 1,
      graphDpr: 1,
      graphLabelResolution: 1,
    })
    expect(particleCountForSize(112, 'balanced')).toBe(360)
    expect(particleCountForSize(1_000, 'high')).toBe(500)
    expect(particleCountForSize(16, 'low')).toBe(160)
  })
})
