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
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
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
      frame?.(0)

      expect(canvas.offsetX.value).toBe(1_000_000)
      expect(canvas.offsetY.value).toBe(-1_000_000)

      canvas.onPointerMove({
        pointerId: 1,
        clientX: -1_000_000,
        clientY: 1_000_000,
      } as PointerEvent)
      frame?.(1)
      expect(canvas.offsetX.value).toBe(-1_000_000)
      expect(canvas.offsetY.value).toBe(1_000_000)
    })
    scope.stop()
    vi.unstubAllGlobals()
  })

  it('places fitting content toward the top while keeping its first node visible', () => {
    const fitted = calculateFitTransform({
      viewport: { width: 1200, height: 700 },
      content: { width: 600, height: 400 },
      minScale: 0.32,
      maxScale: 2.2,
      padding: 18,
    })

    expect(fitted).toEqual({ scale: 1, x: 300, y: 18 })
  })

  it('reports when an initial fit must be retried after geometry becomes ready', () => {
    let viewport = { width: 0, height: 0 }
    let content = { width: 0, height: 0 }
    const scope = effectScope()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () =>
          ({ clientWidth: viewport.width, clientHeight: viewport.height }) as HTMLElement,
        contentSize: () => content,
      })

      expect(canvas.fitToView()).toBe(false)
      expect({
        scale: canvas.scale.value,
        x: canvas.offsetX.value,
        y: canvas.offsetY.value,
      }).toEqual({
        scale: 1,
        x: 0,
        y: 0,
      })

      viewport = { width: 1200, height: 700 }
      content = { width: 600, height: 400 }
      expect(canvas.fitToView()).toBe(true)
      expect({
        scale: canvas.scale.value,
        x: canvas.offsetX.value,
        y: canvas.offsetY.value,
      }).toEqual({
        scale: 1,
        x: 300,
        y: 14,
      })
    })
    scope.stop()
  })

  it('presents deferred drag frames without committing reactive offsets until release', () => {
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const onDragFrame = vi.fn()
    const onDragEnd = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLElement,
        contentSize: () => ({ width: 400, height: 500 }),
        deferDragCommit: true,
        onDragFrame,
        onDragEnd,
      })
      const currentTarget = {
        setPointerCapture: vi.fn(),
        hasPointerCapture: vi.fn(() => false),
      }
      canvas.onPointerDown({
        button: 0,
        pointerId: 7,
        clientX: 20,
        clientY: 30,
        currentTarget,
        preventDefault: vi.fn(),
      } as unknown as PointerEvent)
      canvas.onPointerMove({ pointerId: 7, clientX: 120, clientY: 180 } as PointerEvent)
      frame?.(0)

      expect(onDragFrame).toHaveBeenLastCalledWith({ scale: 1, x: 100, y: 150 })
      expect(canvas.offsetX.value).toBe(0)
      expect(canvas.offsetY.value).toBe(0)

      canvas.onPointerUp({ pointerId: 7, currentTarget } as unknown as PointerEvent)
      expect(canvas.offsetX.value).toBe(100)
      expect(canvas.offsetY.value).toBe(150)
      expect(onDragEnd).toHaveBeenLastCalledWith({ scale: 1, x: 100, y: 150 })
    })
    scope.stop()
    vi.unstubAllGlobals()
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

    expect(fitted).toEqual({ scale: 1, x: 500, y: 0 })
    expect(screenToWorld(screen, fitted)).toEqual(world)
  })

  it('suppresses exactly one click after a threshold drag', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
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
    vi.unstubAllGlobals()
  })
})

describe('tree canvas horizontal tail follow', () => {
  it('shifts the whole tree left once the tail crosses the right-edge ratio', () => {
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const nowSpy = vi.spyOn(performance, 'now')
    const scope = effectScope()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 1200, clientHeight: 700 }) as HTMLElement,
        contentSize: () => ({ width: 1000, height: 400 }),
      })
      // scale=1、offsetX=0：endX=1000 → 屏幕位置 1000 > 960（视口 80%），应左移 40px。
      nowSpy.mockReturnValue(0)
      canvas.followContentEndX(1000)
      expect(frame).toBeTypeOf('function')
      frame?.(0) // progress=0
      nowSpy.mockReturnValue(1000) // 越过 240ms 时长
      frame?.(1000) // progress=1 → 终值
      expect(canvas.offsetX.value).toBe(-40)
      // 跟随只移动 offsetX，不重新 fit，节点尺寸（scale）保持默认不变。
      expect(canvas.scale.value).toBe(1)
    })
    scope.stop()
    nowSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('keeps the tree stationary while the tail stays inside the right-edge ratio', () => {
    const scope = effectScope()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 1200, clientHeight: 700 }) as HTMLElement,
        contentSize: () => ({ width: 1000, height: 400 }),
      })
      // 900 < 960：仍在右侧 20% 留白以内，不移动。
      canvas.followContentEndX(900)
      expect(canvas.offsetX.value).toBe(0)
    })
    scope.stop()
  })

  it('does not take over the camera after the user panned', () => {
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const scope = effectScope()
    scope.run(() => {
      const canvas = useTreeCanvas({
        viewport: () => ({ clientWidth: 800, clientHeight: 600 }) as HTMLElement,
        contentSize: () => ({ width: 400, height: 500 }),
        deferDragCommit: true,
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
      frame?.(0)

      expect(canvas.userPanned.value).toBe(true)
      canvas.followContentEndX(2000)
      expect(canvas.offsetX.value).toBe(0)
    })
    scope.stop()
    vi.unstubAllGlobals()
  })

  it('places the newest node 20% away from the right edge on load without fitting full width', () => {
    const fitted = calculateFitTransform({
      viewport: { width: 1200, height: 700 },
      content: { width: 800, height: 400 },
      bounds: { minX: 0, minY: 0, maxX: 800, maxY: 400 },
      minScale: 0.32,
      maxScale: 1.6,
      padding: 18,
      align: 'right',
      scale: 1,
      tailRatio: 0.8,
    })

    // 固定 scale=1（节点默认尺寸）；最右节点右缘停在视口宽 80% 处，距右缘 20%（240px），
    // 而不是 fit 铺满全宽或贴右缘。
    expect(fitted.scale).toBe(1)
    expect(fitted.x).toBe(160)
    expect(fitted.x + fitted.scale * 800).toBe(960)
    expect(1200 - (fitted.x + fitted.scale * 800)).toBe(240)
  })
})
