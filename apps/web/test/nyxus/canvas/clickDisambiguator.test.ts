import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClickDisambiguator } from '../../../src/features/pets/nyxus/composables/clickDisambiguator'

describe('Cherry Nyxus click disambiguation', () => {
  afterEach(() => vi.useRealTimers())

  it('runs the single-click action only after the double-click window', () => {
    vi.useFakeTimers()
    const single = vi.fn()
    const double = vi.fn()
    const intent = createClickDisambiguator(single, double, 220)

    intent.single()
    vi.advanceTimersByTime(219)
    expect(single).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(single).toHaveBeenCalledOnce()
    expect(double).not.toHaveBeenCalled()
  })

  it('cancels the pending single-click action when a double click arrives', () => {
    vi.useFakeTimers()
    const single = vi.fn()
    const double = vi.fn()
    const intent = createClickDisambiguator(single, double, 220)

    intent.single()
    intent.double()
    vi.runAllTimers()
    expect(single).not.toHaveBeenCalled()
    expect(double).toHaveBeenCalledOnce()
  })
})
