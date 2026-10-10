import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopPassthroughState,
  type DesktopHitProbe,
} from '../../src/features/desktop/desktopPassthroughState'

const PET_BOUNDS = { left: 40, top: 40, right: 100, bottom: 120 }

describe('desktop mouse passthrough state', () => {
  afterEach(() => vi.useRealTimers())

  function setup(initialProbe: DesktopHitProbe = { interactive: false }) {
    let probe = initialProbe
    let interacting = false
    const setMousePassthrough = vi.fn()
    const state = createDesktopPassthroughState({
      probe: () => probe,
      isInteracting: () => interacting,
      setMousePassthrough,
    })
    return {
      state,
      setProbe: (value: DesktopHitProbe) => (probe = value),
      setInteracting: (value: boolean) => (interacting = value),
      setMousePassthrough,
    }
  }

  it('delays passthrough after leaving an interactive region', () => {
    vi.useFakeTimers()
    const ctx = setup()

    ctx.state.move(200, 200)
    vi.advanceTimersByTime(119)
    expect(ctx.setMousePassthrough).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(ctx.setMousePassthrough).toHaveBeenCalledOnce()
    expect(ctx.setMousePassthrough).toHaveBeenLastCalledWith(true)
  })

  it('cancels a pending exit when the pointer quickly returns to the pet', () => {
    vi.useFakeTimers()
    const ctx = setup()

    ctx.state.move(200, 200)
    vi.advanceTimersByTime(80)
    ctx.setProbe({ interactive: true, bounds: PET_BOUNDS })
    ctx.state.move(70, 70)
    vi.runAllTimers()

    expect(ctx.setMousePassthrough).not.toHaveBeenCalled()
  })

  it('keeps the window interactive inside the pet boundary hysteresis', () => {
    vi.useFakeTimers()
    const ctx = setup({ interactive: true, bounds: PET_BOUNDS })

    ctx.state.move(70, 70)
    ctx.setProbe({ interactive: false })
    ctx.state.move(104, 70)
    vi.advanceTimersByTime(199)
    expect(ctx.setMousePassthrough).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(ctx.setMousePassthrough).toHaveBeenLastCalledWith(true)
  })

  it('cancels a pending exit while another interaction guard is active', () => {
    vi.useFakeTimers()
    const ctx = setup()

    ctx.state.move(200, 200)
    vi.advanceTimersByTime(80)
    ctx.setInteracting(true)
    ctx.state.move(200, 200)
    vi.runAllTimers()
    expect(ctx.setMousePassthrough).not.toHaveBeenCalled()

    ctx.setInteracting(false)
    ctx.state.move(200, 200)
    vi.advanceTimersByTime(120)
    expect(ctx.setMousePassthrough).toHaveBeenLastCalledWith(true)
  })

  it('does not rapidly flip native state during repeated boundary crossings', () => {
    vi.useFakeTimers()
    const ctx = setup()

    for (let i = 0; i < 4; i += 1) {
      ctx.setProbe({ interactive: false })
      ctx.state.move(200, 200)
      vi.advanceTimersByTime(60)
      ctx.setProbe({ interactive: true, bounds: PET_BOUNDS })
      ctx.state.move(70, 70)
      vi.advanceTimersByTime(60)
    }
    expect(ctx.setMousePassthrough).not.toHaveBeenCalled()

    ctx.setProbe({ interactive: false })
    ctx.state.move(200, 200)
    vi.advanceTimersByTime(120)
    ctx.setProbe({ interactive: true, bounds: PET_BOUNDS })
    ctx.state.move(70, 70)

    expect(ctx.setMousePassthrough.mock.calls).toEqual([[true], [false]])
  })

  it('cancels pending timers when disposed', () => {
    vi.useFakeTimers()
    const ctx = setup()

    ctx.state.move(200, 200)
    ctx.state.dispose()
    vi.runAllTimers()

    expect(ctx.setMousePassthrough).not.toHaveBeenCalled()
  })
})
