import { describe, expect, it } from 'vitest'
import { treeResetProgress } from '../../web/src/features/pets/nyxus/composables/useTreeCanvas'

describe('Nyxus tree reset motion', () => {
  it('moves continuously from the dragged state to the fitted state', () => {
    expect(treeResetProgress(0)).toBe(0)
    expect(treeResetProgress(0.25)).toBeGreaterThan(0)
    expect(treeResetProgress(0.25)).toBeLessThan(treeResetProgress(0.5))
    expect(treeResetProgress(0.5)).toBeLessThan(treeResetProgress(0.75))
    expect(treeResetProgress(1)).toBe(1)
  })

  it('clamps timing values so reset cannot overshoot either endpoint', () => {
    expect(treeResetProgress(-1)).toBe(0)
    expect(treeResetProgress(2)).toBe(1)
  })
})
