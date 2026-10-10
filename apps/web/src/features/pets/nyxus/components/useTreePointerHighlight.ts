import { onScopeDispose, watch, type Ref } from 'vue'
import { gsap } from 'gsap'
import { useGsap } from '@/composables/useGsap'
import { useMotionPreference } from '@/composables/useMotionPreference'

interface TreePointerHighlightOptions {
  host: Ref<HTMLElement | null>
  layer: Ref<HTMLElement | null>
  suspended: Readonly<Ref<boolean | undefined>>
}

const POINTER_SIZE = 26

export function useTreePointerHighlight(options: TreePointerHighlightOptions): void {
  const { effectiveMode } = useMotionPreference()
  let dispose: (() => void) | undefined
  let hide: (() => void) | undefined

  useGsap(options.host, () => {
    const host = options.host.value
    const layer = options.layer.value
    if (!host || !layer || typeof window === 'undefined') return

    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
    let activeTarget: HTMLElement | undefined
    let hostRect = host.getBoundingClientRect()
    const enabled = () =>
      finePointer.matches &&
      !options.suspended.value
    const geometryFor = (x: number, y: number, width: number, height: number) => ({
      x,
      y,
      width,
      height,
    })
    const clearTarget = () => {
      activeTarget?.classList.remove('is-pointer-highlighted')
      activeTarget = undefined
      layer.dataset.mode = 'pointer'
      gsap.set(layer, { '--tree-pointer-accent': 'var(--nx-cyan)' })
    }
    const stopMotion = () => gsap.killTweensOf(layer)

    hide = () => {
      clearTarget()
      host.classList.remove('is-pointer-highlight-active')
      stopMotion()
      gsap.to(layer, { opacity: 0, duration: 0.12, ease: 'power2.out', overwrite: true })
    }
    const moveToPointer = (event: PointerEvent) => {
      clearTarget()
      stopMotion()
      gsap.set(layer, {
        ...geometryFor(
          event.clientX - hostRect.left - POINTER_SIZE / 2,
          event.clientY - hostRect.top - POINTER_SIZE / 2,
          POINTER_SIZE,
          POINTER_SIZE,
        ),
        opacity: 1,
      })
    }
    const moveToTarget = (target: HTMLElement) => {
      if (target === activeTarget) return
      clearTarget()
      activeTarget = target
      target.classList.add('is-pointer-highlighted')
      layer.dataset.mode = 'node'
      const rect = target.getBoundingClientRect()
      const accent = target.style.getPropertyValue('--tree-node-accent') || 'var(--nx-cyan)'
      stopMotion()
      gsap.to(layer, {
        ...geometryFor(
          rect.left - hostRect.left,
          rect.top - hostRect.top,
          rect.width,
          rect.height,
        ),
        '--tree-pointer-accent': accent,
        opacity: 1,
        duration: effectiveMode.value === 'reduced' ? 0 : 0.42,
        ease: 'elastic.out(1, 0.62)',
        overwrite: true,
      })
    }
    const onPointerEnter = (event: PointerEvent) => {
      if (!enabled() || event.pointerType !== 'mouse') return
      host.classList.add('is-pointer-highlight-active')
      hostRect = host.getBoundingClientRect()
      moveToPointer(event)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!enabled() || event.pointerType !== 'mouse') {
        hide?.()
        return
      }
      host.classList.add('is-pointer-highlight-active')
      const origin = event.target instanceof Element ? event.target : undefined
      const target = origin?.closest<HTMLElement>('[data-execution-node-id]')
      if (target && host.contains(target)) moveToTarget(target)
      else moveToPointer(event)
    }
    const onPointerLeave = () => hide?.()
    const onViewportChange = () => hide?.()

    gsap.set(layer, { ...geometryFor(0, 0, POINTER_SIZE, POINTER_SIZE), opacity: 0 })
    host.addEventListener('pointerenter', onPointerEnter)
    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerleave', onPointerLeave)
    host.addEventListener('wheel', onViewportChange, { passive: true })
    finePointer.addEventListener('change', onViewportChange)

    dispose = () => {
      clearTarget()
      host.classList.remove('is-pointer-highlight-active')
      stopMotion()
      host.removeEventListener('pointerenter', onPointerEnter)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('wheel', onViewportChange)
      finePointer.removeEventListener('change', onViewportChange)
    }
  })

  watch([effectiveMode, options.suspended], () => {
    if (options.suspended.value) hide?.()
  })
  onScopeDispose(() => {
    dispose?.()
    dispose = undefined
    hide = undefined
  })
}
