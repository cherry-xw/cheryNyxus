import { onScopeDispose, watch, type Ref } from 'vue'
import { gsap } from 'gsap'
import { useGsap } from '@/composables/useGsap'
import { useMotionPreference } from '@/composables/useMotionPreference'

interface WorkflowPointerHighlightOptions {
  host: Ref<HTMLElement | null>
  layer: Ref<HTMLElement | null>
  suspended: Readonly<Ref<boolean>>
}

const POINTER_SIZE = 22

export function useWorkflowPointerHighlight(options: WorkflowPointerHighlightOptions): void {
  const { effectiveMode } = useMotionPreference()
  let dispose: (() => void) | undefined
  let hide: (() => void) | undefined

  useGsap(options.host, () => {
    const host = options.host.value
    const layer = options.layer.value
    if (!host || !layer || typeof window === 'undefined') return

    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
    const xTo = gsap.quickTo(layer, 'x', { duration: 0.2, ease: 'power3.out' })
    const yTo = gsap.quickTo(layer, 'y', { duration: 0.2, ease: 'power3.out' })
    const widthTo = gsap.quickTo(layer, 'width', { duration: 0.2, ease: 'power3.out' })
    const heightTo = gsap.quickTo(layer, 'height', { duration: 0.2, ease: 'power3.out' })
    const opacityTo = gsap.quickTo(layer, 'opacity', { duration: 0.12, ease: 'power2.out' })
    let activeTarget: HTMLElement | undefined
    let hostRect = host.getBoundingClientRect()

    const enabled = () =>
      finePointer.matches && effectiveMode.value === 'full' && !options.suspended.value

    const clearTarget = () => {
      activeTarget?.classList.remove('is-pointer-highlighted')
      activeTarget = undefined
      layer.dataset.mode = 'pointer'
    }

    hide = () => {
      clearTarget()
      opacityTo(0)
    }

    const moveToPointer = (event: PointerEvent) => {
      clearTarget()
      xTo(event.clientX - hostRect.left - POINTER_SIZE / 2)
      yTo(event.clientY - hostRect.top - POINTER_SIZE / 2)
      widthTo(POINTER_SIZE)
      heightTo(POINTER_SIZE)
    }

    const moveToTarget = (target: HTMLElement) => {
      if (target === activeTarget) return
      clearTarget()
      activeTarget = target
      activeTarget.classList.add('is-pointer-highlighted')
      layer.dataset.mode = 'node'
      const rect = target.getBoundingClientRect()
      xTo(rect.left - hostRect.left)
      yTo(rect.top - hostRect.top)
      widthTo(rect.width)
      heightTo(rect.height)
    }

    const onPointerEnter = (event: PointerEvent) => {
      if (!enabled() || event.pointerType !== 'mouse') return
      hostRect = host.getBoundingClientRect()
      moveToPointer(event)
      opacityTo(1)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!enabled() || event.pointerType !== 'mouse') {
        hide?.()
        return
      }
      const eventTarget = event.target instanceof Element ? event.target : undefined
      const target = eventTarget?.closest<HTMLElement>('[data-workflow-highlight-target]')
      if (target && host.contains(target)) moveToTarget(target)
      else moveToPointer(event)
      opacityTo(1)
    }
    const onPointerLeave = () => hide?.()
    const onViewportChange = () => hide?.()
    const onPointerCapabilityChange = () => {
      if (!enabled()) hide?.()
    }

    gsap.set(layer, { x: 0, y: 0, width: POINTER_SIZE, height: POINTER_SIZE, opacity: 0 })
    host.addEventListener('pointerenter', onPointerEnter)
    host.addEventListener('pointermove', onPointerMove)
    host.addEventListener('pointerleave', onPointerLeave)
    host.addEventListener('wheel', onViewportChange, { passive: true })
    finePointer.addEventListener('change', onPointerCapabilityChange)

    dispose = () => {
      clearTarget()
      host.removeEventListener('pointerenter', onPointerEnter)
      host.removeEventListener('pointermove', onPointerMove)
      host.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('wheel', onViewportChange)
      finePointer.removeEventListener('change', onPointerCapabilityChange)
      for (const quickTo of [xTo, yTo, widthTo, heightTo, opacityTo]) quickTo.tween?.kill()
    }
  })

  watch([effectiveMode, options.suspended], () => {
    if (effectiveMode.value !== 'full' || options.suspended.value) hide?.()
  })
  onScopeDispose(() => {
    dispose?.()
    dispose = undefined
    hide = undefined
  })
}
