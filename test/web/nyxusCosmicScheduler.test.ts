import { describe, expect, it } from 'vitest'
import {
  createNyxusCosmicModeBag,
  createNyxusCosmicScheduler,
  NYXUS_IDLE_COSMIC_MODES,
  nyxusForcedCosmicState,
} from '../../web/src/features/pets/nyxus/composables/cosmicScheduler'
import { cosmicModeDuration } from '../../web/src/features/pets/nyxus/particles/nyxusParticleEngine'

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('nyxus cosmic scheduler', () => {
  it('covers every idle mode once while keeping both dual modes apart', () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const bag = createNyxusCosmicModeBag(seededRandom(seed), seed % 2 === 0 ? 'binary' : 'merger')
      expect(bag).toHaveLength(NYXUS_IDLE_COSMIC_MODES.length)
      expect(new Set(bag)).toEqual(new Set(NYXUS_IDLE_COSMIC_MODES))
      expect(bag).toContain('singleRing')
      expect(bag).toContain('multiRing')
      expect(bag).not.toContain('pulsar')
      expect(bag[0]).not.toBe(seed % 2 === 0 ? 'binary' : 'merger')
      expect(['binary', 'merger']).not.toContain(bag[0])
      const binaryIndex = bag.indexOf('binary')
      const mergerIndex = bag.indexOf('merger')
      expect(Math.abs(binaryIndex - mergerIndex)).toBeGreaterThan(1)
    }
  })

  it('pauses a running long shape during temporary higher-priority activity', () => {
    const scheduler = createNyxusCosmicScheduler(() => 0)
    scheduler.initialize(0, false)
    expect(scheduler.update(11999, true, false, false).mode).toBeNull()

    const started = scheduler.update(12000, true, false, false)
    expect(started.mode).not.toBeNull()
    const mode = started.mode!
    const beforePause = scheduler.update(22000, true, false, false)
    expect(beforePause.progress).toBeCloseTo(10 / cosmicModeDuration(mode))

    expect(scheduler.update(23000, false, false, false)).toEqual({ mode: null, progress: 0 })
    expect(scheduler.update(53000, false, false, false)).toEqual({ mode: null, progress: 0 })
    const resumed = scheduler.update(54000, true, false, false)
    expect(resumed.mode).toBe(mode)
    expect(resumed.progress).toBeCloseTo(11 / cosmicModeDuration(mode))
  })

  it('reserves pulsar for loading while disconnected black hole stays higher priority', () => {
    expect(nyxusForcedCosmicState('connected', false)).toBeNull()
    expect(nyxusForcedCosmicState('connected', true)).toEqual({ mode: 'pulsar', progress: 0.5 })
    expect(nyxusForcedCosmicState('disconnected', true)).toEqual({
      mode: 'blackHole',
      progress: 0.5,
    })
  })
})
