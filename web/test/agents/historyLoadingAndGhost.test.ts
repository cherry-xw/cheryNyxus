import { describe, expect, it } from 'vitest'
import { ghostTrailDistance, pointAtArc } from '../../src/domain/pets/motion/movement'

describe('ghost trail spacing', () => {
  it('places every ghost behind the main agent at stable arc distances', () => {
    expect(ghostTrailDistance(0)).toBe(32)
    expect(ghostTrailDistance(2)).toBe(96)
    const trail = {
      pts: [
        { x: 96, y: 0 },
        { x: 64, y: 0 },
        { x: 32, y: 0 },
        { x: 0, y: 0 },
      ],
    }
    expect(pointAtArc(trail, ghostTrailDistance(0))).toEqual({ x: 64, y: 0 })
    expect(pointAtArc(trail, ghostTrailDistance(2))).toEqual({ x: 0, y: 0 })
  })
})
