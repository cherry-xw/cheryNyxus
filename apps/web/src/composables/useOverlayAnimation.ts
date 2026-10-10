import { onScopeDispose } from 'vue'
import { gsap } from 'gsap'
import { MOTION } from '@/utils/gsapCore'
import { useMotionPreference } from './useMotionPreference'

/** 4 个 overlay 组件共享的 pointerdown 判断：点击 overlay 自身（非 panel 子元素）时触发 close。 */
export function useOverlayClick(close: () => void) {
  return {
    onOverlayClick(e: MouseEvent) {
      if (e.target === e.currentTarget) close()
    },
  }
}

/** dialog 型面板（居中 fade+scale）过渡参数 */
export const dialogPanelTransition = { duration: 0.18, ease: 'easeOut' as const }
/** drawer 型面板（右侧 slide）过渡参数 */
export const drawerPanelTransition = { duration: 0.24, ease: 'easeOut' as const }
/** overlay 通用过渡参数 */
export const overlayTransition = { duration: 0.16 }

export type OverlayTransitionKind = 'dialog' | 'drawer' | 'panel'

/**
 * Vue `<Transition :css="false">` hooks shared by modal surfaces.
 * Each transition owns a scoped GSAP context, is interruptible, and settles Vue's
 * `done` callback exactly once even when visibility changes mid-flight.
 */
export function useOverlayTransitionHooks(kind: OverlayTransitionKind = 'dialog') {
  const { effectiveMode } = useMotionPreference()
  const contexts = new Set<gsap.Context>()
  const active = new WeakMap<Element, { context: gsap.Context; done: () => void }>()

  const settle = (element: Element): void => {
    const current = active.get(element)
    if (!current) return
    active.delete(element)
    current.done()
  }

  const run = (element: Element, phase: 'enter' | 'leave', done: () => void): void => {
    const previous = active.get(element)
    if (previous) {
      previous.context.kill()
      active.delete(element)
      previous.done()
    }
    let settled = false
    const doneOnce = () => {
      if (settled) return
      settled = true
      done()
    }
    const reduced = effectiveMode.value === 'reduced'
    const panel =
      kind === 'panel'
        ? (element as HTMLElement)
        : (element as HTMLElement).querySelector<HTMLElement>(
            '.dialog-panel, .settings-panel, .drawer-panel, .workbench-shell, [data-motion-panel]',
          )
    const context = gsap.context(() => {
      const timeline = gsap.timeline({
        defaults: { overwrite: 'auto' },
        onComplete: () => {
          active.delete(element)
          doneOnce()
        },
      })
      const entering = phase === 'enter'
      timeline.fromTo(
        element,
        { autoAlpha: entering ? 0 : 1 },
        {
          autoAlpha: entering ? 1 : 0,
          duration: MOTION.control,
          ease: entering ? MOTION.easePanel : MOTION.easeExit,
        },
      )
      if (panel && !reduced) {
        const axis = kind === 'drawer' ? 'x' : 'y'
        const offset = kind === 'drawer' ? 24 : 10
        timeline.fromTo(
          panel,
          {
            autoAlpha: entering ? 0 : 1,
            [axis]: entering ? offset : 0,
            scale: entering && kind === 'dialog' ? 0.985 : 1,
          },
          {
            autoAlpha: entering ? 1 : 0,
            [axis]: entering ? 0 : offset * 0.5,
            scale: entering ? 1 : kind === 'dialog' ? 0.99 : 1,
            duration: entering ? MOTION.panel : MOTION.control,
            ease: entering ? MOTION.easePanel : MOTION.easeExit,
          },
          entering ? 0.02 : 0,
        )
      }
    }, element)
    contexts.add(context)
    active.set(element, { context, done: doneOnce })
  }

  onScopeDispose(() => {
    for (const context of contexts) context.revert()
    contexts.clear()
  })

  return {
    onBeforeEnter: (element: Element) => gsap.set(element, { autoAlpha: 0 }),
    onEnter: (element: Element, done: () => void) => run(element, 'enter', done),
    onLeave: (element: Element, done: () => void) => run(element, 'leave', done),
    onEnterCancelled: settle,
    onLeaveCancelled: settle,
  }
}
