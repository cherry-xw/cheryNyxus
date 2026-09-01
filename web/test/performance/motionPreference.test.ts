import { describe, expect, it } from 'vitest'
import { resolveMotionMode } from '../../src/composables/useMotionPreference'

describe('motion preference resolution', () => {
  it('follows the operating system only in system mode', () => {
    expect(resolveMotionMode('system', true)).toBe('reduced')
    expect(resolveMotionMode('system', false)).toBe('full')
    expect(resolveMotionMode('full', true)).toBe('full')
    expect(resolveMotionMode('reduced', false)).toBe('reduced')
  })
})
