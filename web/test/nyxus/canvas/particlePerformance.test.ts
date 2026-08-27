import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../../helpers/componentSource'

describe('Nyxus particle performance contract', () => {
  it('caps pixels and decouples rendering, simulation and atmosphere rates', async () => {
    const source = await readComponentSource(
      resolve('web/src/features/pets/nyxus/components/NyxusParticle.vue'),
      'utf8',
    )

    expect(source).toContain('profile.value.particleDpr')
    expect(source).toContain('const SIMULATION_STEP_SECONDS = 1 / 30')
    expect(source).toContain('const renderIntervalMs = 1000 / activeFrameRate()')
    expect(source).toContain(
      'const atmosphereInterval = 1000 / profile.value.particleAtmosphereFps',
    )
    expect(source).toContain('{ pixelRatio: ratio, refreshAtmosphere }')
  })

  it('pauses offscreen or hidden canvases and lowers covered surfaces to low quality', async () => {
    const source = await readComponentSource(
      resolve('web/src/features/pets/nyxus/components/NyxusParticle.vue'),
      'utf8',
    )

    expect(source).toContain("props.background ? 'low' : quality.tier.value")
    expect(source).toContain('pausedByVisibility = document.hidden')
    expect(source).toContain('new IntersectionObserver')
    expect(source).toContain('if (pausedByVisibility || !insideViewport) return')
    expect(source).toContain('intersectionObserver?.disconnect()')
  })
})
