import { describe, expect, it } from 'vitest'
import { reconcileAgentLoadingEntries } from '../../src/stores/agents/data/historyLoading'
import { ghostTrailDistance, pointAtArc } from '../../src/domain/pets/motion/movement'

describe('multi-agent history loading', () => {
  it('keeps completed agents while another agent is still running', () => {
    const first = reconcileAgentLoadingEntries(
      [],
      [
        { chatId: 'a', name: 'Agent A', face: 'A' },
        { chatId: 'b', name: 'Agent B', face: 'B' },
      ],
    )
    const second = reconcileAgentLoadingEntries(first, [
      { chatId: 'b', name: 'Agent B', face: 'B' },
    ])

    expect(second).toEqual([
      expect.objectContaining({ chatId: 'a', running: false }),
      expect.objectContaining({ chatId: 'b', running: true }),
    ])
  })
})

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
