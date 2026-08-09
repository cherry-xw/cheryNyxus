import { effectScope } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  calculateFitTransform,
  screenToWorld,
  useTreeCanvas,
  worldToScreen,
} from '../../../src/features/pets/nyxus/composables/useTreeCanvas'

describe('tree canvas long-content behavior', () => {
  it('top-aligns a tree that cannot fit at the minimum scale', () => {
    const fitted = calculateFitTransform({
      viewport: { width: 1200, height: 700 },
      content: { width: 1000, height: 82_000 },
      focus: { x: 500, y: 0 },
      minScale: 0.32,
      maxScale: 2.2,
      padding: 18,
    })

    expect(fitted.scale).toBe(0.32)
    expect(fitted.x).toBe(440)
    expect(fitted.y).toBe(18)
  })

  it('allows unrestricted pan far beyond every content boundary', () => {
    const scope = effectScope()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 1200, clientHeight: 700 }) as HTMLElement,
        contentSize: () => ({ width: 1000, height: 82_000 }),
      })
      const currentTarget = { setPointerCapture: vi.fn() }
      canvas.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        currentTarget,
        preventDefault: vi.fn(),
      } as unknown as PointerEvent)
      canvas.onPointerMove({
        pointerId: 1,
        clientX: 1_000_000,
        clientY: -1_000_000,
      } as PointerEvent)

      expect(canvas.offsetX.value).toBe(1_000_000)
      expect(canvas.offsetY.value).toBe(-1_000_000)

      canvas.onPointerMove({
        pointerId: 1,
        clientX: -1_000_000,
        clientY: 1_000_000,
      } as PointerEvent)
      expect(canvas.offsetX.value).toBe(-1_000_000)
      expect(canvas.offsetY.value).toBe(1_000_000)
    })
    scope.stop()
  })

  it('continues to center content that fits inside the viewport', () => {
    const fitted = calculateFitTransform({
      viewport: { width: 1200, height: 700 },
      content: { width: 600, height: 400 },
      minScale: 0.32,
      maxScale: 2.2,
      padding: 18,
    })

    expect(fitted).toEqual({ scale: 1, x: 300, y: 150 })
  })

  it('prevents native text selection when canvas dragging starts', () => {
    const scope = effectScope()
    const preventDefault = vi.fn()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLElement,
        contentSize: () => ({ width: 400, height: 500 }),
      })
      canvas.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 40,
        clientY: 50,
        currentTarget: { setPointerCapture: vi.fn() },
        preventDefault,
      } as unknown as PointerEvent)
    })
    scope.stop()

    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('fits negative-x world bounds and keeps world/screen conversion invertible', () => {
    const fitted = calculateFitTransform({
      viewport: { width: 800, height: 600 },
      content: { width: 600, height: 400 },
      bounds: { minX: -400, minY: 20, maxX: 200, maxY: 420 },
      minScale: 0.32,
      maxScale: 2.2,
      padding: 20,
    })
    const world = { x: -175, y: 210 }
    const screen = worldToScreen(world, fitted)

    expect(fitted).toEqual({ scale: 1, x: 500, y: 80 })
    expect(screenToWorld(screen, fitted)).toEqual(world)
  })

  it('suppresses exactly one click after a threshold drag', () => {
    const scope = effectScope()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLElement,
        contentSize: () => ({ width: 400, height: 500 }),
        threshold: 4,
      })
      canvas.onPointerDown({
        button: 0,
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        currentTarget: { setPointerCapture: vi.fn() },
        preventDefault: vi.fn(),
      } as unknown as PointerEvent)
      canvas.onPointerMove({ pointerId: 1, clientX: 10, clientY: 0 } as PointerEvent)

      expect(canvas.consumeClickAfterDrag()).toBe(true)
      expect(canvas.consumeClickAfterDrag()).toBe(false)
    })
    scope.stop()
  })
})
