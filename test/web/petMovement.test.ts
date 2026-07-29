import { describe, expect, it } from 'vitest'
import {
  NYXUS_EXCLUSION_RADIUS,
  stepMovement,
} from '../../web/src/features/pets/motion/petMovement'
import type { PetInstance } from '../../web/src/features/pets/types/types'

function movementPet(overrides: Partial<PetInstance>): PetInstance {
  return {
    instanceId: 'pet',
    visualKind: 'default',
    isMaster: false,
    tribe: 'tribe',
    x: 0,
    y: 100,
    vx: 0,
    vy: 0,
    targetX: 0,
    targetY: 100,
    width: 72,
    height: 96,
    direction: 1,
    action: 'walk',
    bubbleRepelExtra: 0,
    ...overrides,
  } as PetInstance
}

describe('Nyxus movement exclusion field', () => {
  it.each([
    ['same tribe', 'nyxus'],
    ['different tribe', 'another-tribe'],
  ])('repels Nyxus and a nearby pet in both directions for the %s', (_, tribe) => {
    const nyxus = movementPet({
      instanceId: 'nyxus',
      visualKind: 'chery-nyxus',
      isMaster: true,
      tribe: 'nyxus',
      x: 100,
      targetX: 100,
    })
    const agentPet = movementPet({
      instanceId: 'agent',
      tribe,
      x: 220,
      targetX: 220,
    })

    expect(Math.abs(agentPet.x - nyxus.x)).toBeLessThan(NYXUS_EXCLUSION_RADIUS)
    stepMovement(nyxus, [nyxus, agentPet], { width: 1000, height: 700 }, 1 / 60)
    stepMovement(agentPet, [nyxus, agentPet], { width: 1000, height: 700 }, 1 / 60)

    expect(nyxus.vx).toBeLessThan(0)
    expect(agentPet.vx).toBeGreaterThan(0)
  })

  it('separates exact overlaps instead of leaving pets stacked', () => {
    const nyxus = movementPet({
      instanceId: 'nyxus',
      visualKind: 'chery-nyxus',
      x: 200,
      targetX: 200,
    })
    const agentPet = movementPet({ instanceId: 'agent', x: 200, targetX: 200 })

    stepMovement(nyxus, [nyxus, agentPet], { width: 1000, height: 700 }, 1 / 60)

    expect(nyxus.vx).not.toBe(0)
    expect(Number.isFinite(nyxus.x + nyxus.y)).toBe(true)
  })

  it('still rejects a nearby pet while that agent is working', () => {
    const nyxus = movementPet({
      instanceId: 'nyxus',
      visualKind: 'chery-nyxus',
      x: 100,
      targetX: 100,
    })
    const workingPet = movementPet({
      instanceId: 'working-agent',
      action: 'chatting',
      x: 220,
      targetX: 220,
    })

    stepMovement(nyxus, [nyxus, workingPet], { width: 1000, height: 700 }, 1 / 60)

    expect(nyxus.vx).toBeLessThan(0)
  })
})
