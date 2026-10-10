import { describe, expect, it } from 'vitest'
import { nyxusForcedCosmicState } from '../../src/features/pets/nyxus/composables/cosmicScheduler'

describe('Nyxus connection cosmic state', () => {
  it('uses a black hole while connecting or disconnected', () => {
    expect(nyxusForcedCosmicState('connecting', false)).toEqual({
      mode: 'blackHole',
      progress: 0.5,
    })
    expect(nyxusForcedCosmicState('disconnected', false)).toEqual({
      mode: 'blackHole',
      progress: 0.5,
    })
  })

  it('only releases the black hole after connection succeeds', () => {
    expect(nyxusForcedCosmicState('connected', false)).toBeNull()
    expect(nyxusForcedCosmicState('connected', true)).toEqual({
      mode: 'pulsar',
      progress: 0.5,
    })
  })
})
