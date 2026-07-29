import { describe, expect, it } from 'vitest'
import {
  contributesToNyxusFog,
  cosmicModeDuration,
  createNyxusParticles,
  nyxusChromaticStrength,
  nyxusParticleCoreRadius,
  nyxusParticleHaloRadius,
  NYXUS_CHROMATIC_CYCLE_SECONDS,
  particleTarget,
  resolveNyxusMode,
  stepNyxusParticles,
  toneForNyxus,
  type NyxusCosmicMode,
  type NyxusParticleInput,
} from '../../web/src/features/pets/particles/nyxusParticleEngine'

function input(overrides: Partial<NyxusParticleInput> = {}): NyxusParticleInput {
  return {
    action: 'idle',
    mood: 'serious',
    working: false,
    reaction: null,
    connected: true,
    menuOpen: false,
    menuTargets: [],
    highlightedMenuIndex: -1,
    pointer: { x: 0, y: 0 },
    pointerDistance: Number.POSITIVE_INFINITY,
    pointerSpeed: 0,
    pointerActive: false,
    pointerDown: false,
    actionAge: 0,
    cosmicMode: null,
    cosmicProgress: 0,
    bootProgress: 1,
    swipe: { x: 0, y: 0 },
    swipeStrength: 0,
    release: { x: 0, y: 0 },
    releaseStrength: 0,
    time: 1,
    size: 112,
    ...overrides,
  }
}

describe('nyxus particle engine', () => {
  it('creates a deterministic dense particle field', () => {
    const first = createNyxusParticles(500, 42)
    const second = createNyxusParticles(500, 42)

    expect(first).toHaveLength(500)
    expect(first[0]).toEqual(second[0])
    expect(first.some((particle) => particle.brightness === 3)).toBe(true)
  })

  it('stratifies highlighted stars before the simulation begins', () => {
    const particles = createNyxusParticles(800, 84)
    const highlights = particles.filter((particle) => particle.brightness >= 2)
    expect(highlights.length).toBeGreaterThanOrEqual(68)
    for (let left = 0; left < highlights.length; left += 1) {
      for (let right = left + 1; right < highlights.length; right += 1) {
        const a = highlights[left]!
        const b = highlights[right]!
        const ax = Math.cos(a.angle) * a.radius
        const ay = Math.sin(a.angle) * a.radius
        const bx = Math.cos(b.angle) * b.radius
        const by = Math.sin(b.angle) * b.radius
        expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThanOrEqual(0.075 - 1e-9)
      }
    }
  })

  it('lets every white point cycle through red while keeping the instantaneous ratio below four percent', () => {
    for (const count of [500, 650, 800]) {
      for (const seed of [7, 42, 84, 2026]) {
        const particles = createNyxusParticles(count, seed)
        for (let time = 0; time < NYXUS_CHROMATIC_CYCLE_SECONDS; time += 1.75) {
          const redRatio =
            particles.filter((particle) => nyxusChromaticStrength(particle, time) > 0).length /
            particles.length
          expect(redRatio).toBeGreaterThan(0)
          expect(redRatio).toBeLessThanOrEqual(0.04)
        }

        for (const particle of particles.slice(0, 20)) {
          const redAt = (1 - particle.colorCycle) * NYXUS_CHROMATIC_CYCLE_SECONDS
          expect(nyxusChromaticStrength(particle, redAt)).toBeCloseTo(1)
          expect(
            nyxusChromaticStrength(particle, redAt + NYXUS_CHROMATIC_CYCLE_SECONDS / 2),
          ).toBe(0)
        }
      }
    }
  })

  it('preserves visibly different core and halo sizes across brightness tiers', () => {
    const particles = createNyxusParticles(800, 84)
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    const meanRadius = (brightness: number, radiusFor: (particle: (typeof particles)[number]) => number) =>
      mean(particles.filter((particle) => particle.brightness === brightness).map(radiusFor))

    expect(meanRadius(1, nyxusParticleCoreRadius)).toBeGreaterThan(
      meanRadius(0, nyxusParticleCoreRadius) * 1.3,
    )
    expect(meanRadius(2, nyxusParticleCoreRadius)).toBeGreaterThan(
      meanRadius(1, nyxusParticleCoreRadius) * 1.55,
    )
    expect(meanRadius(3, nyxusParticleCoreRadius)).toBeGreaterThan(
      meanRadius(2, nyxusParticleCoreRadius) * 1.3,
    )
    expect(meanRadius(2, nyxusParticleHaloRadius)).toBeGreaterThan(
      meanRadius(1, nyxusParticleHaloRadius) * 2.25,
    )
    expect(meanRadius(3, nyxusParticleHaloRadius)).toBeGreaterThan(
      meanRadius(2, nyxusParticleHaloRadius) * 1.4,
    )
    expect(
      Math.max(...particles.map(nyxusParticleCoreRadius)) -
        Math.min(...particles.map(nyxusParticleCoreRadius)),
    ).toBeGreaterThan(1.3)
  })

  it('separates highlighted cores that are pulled onto the same point', () => {
    const particles = createNyxusParticles(500, 23)
    const highlights = particles.filter((particle) => particle.brightness >= 2)
    const [left, right] = highlights
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    for (const particle of highlights.slice(2)) particle.brightness = 1
    left!.x = 0
    left!.y = 0
    right!.x = 0
    right!.y = 0

    stepNyxusParticles(particles, input({ size: 112 }), 1 / 60)
    expect(Math.hypot(left!.x - right!.x, left!.y - right!.y)).toBeGreaterThanOrEqual(3 - 1e-9)
  })

  it('enforces the interaction priority order', () => {
    const busyMenu = input({
      working: true,
      menuOpen: true,
      menuTargets: [{ x: 50, y: -20 }],
    })
    expect(resolveNyxusMode(busyMenu)).toBe('menu')
    const released = { ...busyMenu, release: { x: 400, y: 0 }, releaseStrength: 0.8 }
    expect(resolveNyxusMode(released)).toBe('released')
    expect(resolveNyxusMode({ ...released, action: 'dragging' })).toBe('dragging')
  })

  it('forms a tapered reach beyond the idle body radius', () => {
    const particles = createNyxusParticles(500, 7)
    const armParticle = particles.find((particle) => particle.armRank < 0.05 && particle.armT > 0.8)
    expect(armParticle).toBeDefined()

    const target = particleTarget(
      armParticle!,
      input({
        action: 'hover',
        pointer: { x: 90, y: 0 },
        pointerDistance: 90,
        pointerActive: true,
      }),
    )
    expect(target.x).toBeGreaterThan(50)
  })

  it('uses one particle layer for stars and fog while excluding reach filaments', () => {
    const particles = createNyxusParticles(500, 7)
    const fogParticles = particles.filter(contributesToNyxusFog)
    expect(fogParticles.length).toBeGreaterThan(70)
    expect(fogParticles.every((particle) => particle.armRank >= 0.18)).toBe(true)
    expect(fogParticles.every((particle) => !('fogX' in particle || 'fogY' in particle))).toBe(true)
  })

  it('keeps weak-gravity integration finite during a released trail', () => {
    const particles = createNyxusParticles(500, 9)
    const state = input({ release: { x: 500, y: 120 }, releaseStrength: 0.75 })
    for (let index = 0; index < 360; index += 1) {
      stepNyxusParticles(particles, state, 1 / 60)
    }
    expect(particles.every((particle) => Number.isFinite(particle.x + particle.y))).toBe(true)
  })

  it('uses bounded durations for every special cosmic mode', () => {
    const modes: NyxusCosmicMode[] = [
      'blackHole',
      'pulsar',
      'binary',
      'supernova',
      'tidalRings',
    ]
    expect(modes.every((mode) => cosmicModeDuration(mode) >= 8)).toBe(true)
    expect(modes.every((mode) => cosmicModeDuration(mode) <= 12)).toBe(true)
  })

  it('builds finite and distinct target fields for every special cosmic mode', () => {
    const particles = createNyxusParticles(500, 61)
    const modes: NyxusCosmicMode[] = [
      'blackHole',
      'pulsar',
      'binary',
      'supernova',
      'tidalRings',
    ]
    const baseline = particles.map((particle) => particleTarget(particle, input({ time: 6 })))

    for (const mode of modes) {
      const targets = particles.map((particle) =>
        particleTarget(particle, input({ cosmicMode: mode, cosmicProgress: 0.5, time: 6 })),
      )
      const meanDifference =
        targets.reduce(
          (sum, target, index) =>
            sum + Math.hypot(target.x - baseline[index]!.x, target.y - baseline[index]!.y),
          0,
        ) / targets.length
      expect(targets.every((target) => Number.isFinite(target.x + target.y))).toBe(true)
      expect(meanDifference).toBeGreaterThan(4)
    }
  })

  it('smoothly enters and leaves cosmic modes while pointer reach stays higher priority', () => {
    const particle = createNyxusParticles(1, 47)[0]!
    const baseline = particleTarget(particle, input({ time: 4 }))
    const entering = particleTarget(
      particle,
      input({ cosmicMode: 'blackHole', cosmicProgress: 0, time: 4 }),
    )
    const leaving = particleTarget(
      particle,
      input({ cosmicMode: 'blackHole', cosmicProgress: 1, time: 4 }),
    )
    expect(entering).toEqual(baseline)
    expect(leaving).toEqual(baseline)

    const reached = input({
      cosmicMode: 'blackHole',
      cosmicProgress: 0.5,
      pointer: { x: 72, y: 0 },
      pointerDistance: 72,
      pointerActive: true,
    })
    expect(resolveNyxusMode(reached)).toBe('reach')
    expect(particleTarget(particle, reached)).not.toEqual(
      particleTarget(particle, { ...reached, pointerActive: false }),
    )
  })

  it('uses a low-saturation warm stellar palette by default', () => {
    const tone = toneForNyxus(input())
    expect(tone).toEqual({
      core: '#181313',
      dust: '#c2aaa6',
      star: '#cf9d96',
      accent: '#d2c0b5',
      spark: '#f3eeea',
    })

    const star = Number.parseInt(tone.star.slice(1), 16)
    expect((star >> 16) & 255).toBeGreaterThan((star >> 8) & 255)
    expect((star >> 16) & 255).toBeGreaterThan(star & 255)
    const channels = [(star >> 16) & 255, (star >> 8) & 255, star & 255]
    const maximum = Math.max(...channels)
    const minimum = Math.min(...channels)
    const saturation = (maximum - minimum) / (255 - Math.abs(maximum + minimum - 255))
    expect(saturation).toBeLessThan(0.4)
  })

  it('uses distinct controlled dual-tone palettes with bounded transition steps', () => {
    const modes: NyxusCosmicMode[] = [
      'blackHole',
      'pulsar',
      'binary',
      'supernova',
      'tidalRings',
    ]
    const modeTones = modes.map((cosmicMode) =>
      toneForNyxus(input({ cosmicMode, cosmicProgress: 0.5 })),
    )
    const lightness = (hex: string) => {
      const value = Number.parseInt(hex.slice(1), 16)
      return (((value >> 16) & 255) + ((value >> 8) & 255) + (value & 255)) / 3
    }
    const saturation = (hex: string) => {
      const value = Number.parseInt(hex.slice(1), 16)
      const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255]
      const maximum = Math.max(...channels)
      const minimum = Math.min(...channels)
      if (maximum === minimum) return 0
      return (maximum - minimum) / (255 - Math.abs(maximum + minimum - 255))
    }
    expect(new Set(modeTones.map((tone) => tone.accent)).size).toBe(modes.length)
    expect(modeTones.every((tone) => tone.spark !== tone.star && tone.accent !== tone.star)).toBe(
      true,
    )
    expect(
      modeTones.every(
        (tone) =>
          lightness(tone.dust) > 150 &&
          lightness(tone.star) > 150 &&
          lightness(tone.accent) > 150,
      ),
    ).toBe(true)
    expect(modeTones.every((tone) => saturation(tone.star) < 0.45)).toBe(true)

    for (const cosmicMode of modes) {
      const transitionStars = new Set<string>()
      for (let step = 0; step <= 100; step += 1) {
        transitionStars.add(
          toneForNyxus(input({ cosmicMode, cosmicProgress: step / 100 })).star,
        )
      }
      expect(transitionStars.size).toBeLessThanOrEqual(9)
    }
  })

  it('continuously changes an irregular outline instead of preserving a circle', () => {
    const particles = createNyxusParticles(500, 17).filter((particle) => particle.radius > 0.9)
    const first = particles.map((particle) => particleTarget(particle, input({ time: 2 })))
    const later = particles.map((particle) => particleTarget(particle, input({ time: 8 })))
    const radialSpread = (points: Array<{ x: number; y: number }>) => {
      const radii = points.map((point) => Math.hypot(point.x, point.y))
      return Math.max(...radii) - Math.min(...radii)
    }
    expect(radialSpread(first)).toBeGreaterThan(8)
    expect(later.some((point, index) => Math.hypot(point.x - first[index]!.x, point.y - first[index]!.y) > 2)).toBe(true)
  })

  it('organizes outer particles into six narrow rotating spiral arms', () => {
    const particles = createNyxusParticles(800, 73).filter(
      (particle) => particle.radius >= 0.7 && particle.radius <= 0.82,
    )
    const points = particles.map((particle) => particleTarget(particle, input({ time: 0 })))
    const armPhase = points.reduce(
      (sum, point, index) => {
        const angle = Math.atan2(point.y, point.x)
        const unwoundAngle = angle - particles[index]!.radius * 4.2
        return {
          x: sum.x + Math.cos(unwoundAngle * 6),
          y: sum.y + Math.sin(unwoundAngle * 6),
        }
      },
      { x: 0, y: 0 },
    )
    const armCoherence = Math.hypot(armPhase.x, armPhase.y) / points.length

    expect(points.length).toBeGreaterThan(50)
    expect(armCoherence).toBeGreaterThan(0.45)
  })

  it('slowly morphs from nearly round into a flattened galaxy disk', () => {
    const particles = createNyxusParticles(800, 91).filter((particle) => particle.radius > 0.35)
    const aspectRatioAt = (time: number) => {
      const points = particles.map((particle) => particleTarget(particle, input({ time })))
      const center = points.reduce(
        (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
        { x: 0, y: 0 },
      )
      center.x /= points.length
      center.y /= points.length
      let xx = 0
      let xy = 0
      let yy = 0
      for (const point of points) {
        const x = point.x - center.x
        const y = point.y - center.y
        xx += x * x
        xy += x * y
        yy += y * y
      }
      const trace = xx + yy
      const split = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)
      return Math.sqrt((trace + split) / Math.max(1, trace - split))
    }

    const round = aspectRatioAt(0)
    const flattened = aspectRatioAt(Math.PI / 0.2)
    expect(round).toBeLessThan(1.3)
    expect(flattened).toBeGreaterThan(round * 1.35)
  })

  it('disrupts near the pointer and gradually returns to the galaxy field', () => {
    const particles = createNyxusParticles(500, 101)
    for (let frame = 0; frame < 180; frame += 1) {
      stepNyxusParticles(particles, input({ time: frame / 60 }), 1 / 60)
    }

    const reachState = input({
      action: 'hover',
      pointer: { x: 70, y: 0 },
      pointerDistance: 70,
      pointerSpeed: 650,
      pointerActive: true,
    })
    for (let frame = 0; frame < 90; frame += 1) {
      stepNyxusParticles(particles, { ...reachState, time: 3 + frame / 60 }, 1 / 60)
    }

    const meanOrbitError = (time: number) =>
      particles.reduce((sum, particle) => {
        const target = particleTarget(particle, input({ time }))
        return sum + Math.hypot(particle.x - target.x, particle.y - target.y)
      }, 0) / particles.length
    const disruptedError = meanOrbitError(4.5)

    for (let frame = 0; frame < 300; frame += 1) {
      stepNyxusParticles(particles, input({ time: 4.5 + frame / 60 }), 1 / 60)
    }
    const recoveredError = meanOrbitError(9.5)

    expect(disruptedError).toBeGreaterThan(3)
    expect(recoveredError).toBeLessThan(disruptedError * 0.65)
  })

  it('keeps the star field in a visible slow orbit outside autonomous actions', () => {
    const particle = createNyxusParticles(1, 31)[0]!
    particle.radius = 0.9
    particle.noise = 0
    const start = particleTarget(particle, input({ time: 0 }))
    const later = particleTarget(particle, input({ time: 20 }))
    const startAngle = Math.atan2(start.y, start.x)
    const laterAngle = Math.atan2(later.y, later.x)
    const turn = Math.abs(Math.atan2(Math.sin(laterAngle - startAngle), Math.cos(laterAngle - startAngle)))

    expect(turn).toBeGreaterThan(0.7)
    expect(turn).toBeLessThan(2.5)
  })
})
