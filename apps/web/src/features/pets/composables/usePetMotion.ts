import { onMounted, onScopeDispose, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import { gsap } from 'gsap'
import type {
  PetMotionDescriptor,
  PetMotionState,
  PetMotionValue,
} from '@/domain/pets/motion/animation'
import { useMotionPreference } from '@/composables/useMotionPreference'
import { MOTION } from '@/utils/gsapCore'

function finalValue(value: PetMotionValue): number | string | undefined {
  return Array.isArray(value) ? (value.at(-1) ?? 0) : value
}

function finalState(state: PetMotionState): Record<string, number | string> {
  return Object.fromEntries(
    Object.entries(state)
      .map(([key, value]) => [key, finalValue(value)] as const)
      .filter((entry): entry is readonly [string, number | string] => entry[1] !== undefined),
  )
}

function gsapEase(descriptor: PetMotionDescriptor): string {
  if (descriptor.transition.type === 'spring') return 'elastic.out(1, 0.35)'
  if (descriptor.transition.ease === 'easeOut') return MOTION.easePanel
  return 'sine.inOut'
}

/** Scoped GSAP executor for the framework-neutral pet motion descriptors. */
export function usePetMotion(
  target: Readonly<Ref<HTMLElement | null>>,
  descriptor: MaybeRefOrGetter<PetMotionDescriptor>,
): void {
  const { effectiveMode } = useMotionPreference()
  let context: gsap.Context | undefined
  let tween: gsap.core.Tween | undefined

  const apply = (): void => {
    const element = target.value
    if (!element || !context) return
    tween?.kill()
    const motion = toValue(descriptor)
    if (effectiveMode.value === 'reduced') {
      context.add(() => gsap.set(element, { ...finalState(motion.animate), clearProps: 'filter' }))
      return
    }
    const transition = motion.transition
    const usesKeyframes = Object.values(motion.animate).some(Array.isArray)
    context.add(() => {
      tween = gsap.to(element, {
        ...(usesKeyframes ? { keyframes: motion.animate } : motion.animate),
        duration: transition.duration ?? MOTION.view,
        repeat: transition.repeat === Infinity ? -1 : (transition.repeat ?? 0),
        yoyo: transition.repeatType === 'reverse' || transition.repeatType === 'mirror',
        ease: gsapEase(motion),
        overwrite: 'auto',
        force3D: true,
      })
    })
  }

  onMounted(() => {
    if (!target.value) return
    context = gsap.context(() => undefined, target.value)
    apply()
  })
  watch([() => toValue(descriptor), effectiveMode], apply, { deep: true })
  onScopeDispose(() => {
    tween?.kill()
    context?.revert()
    context = undefined
  })
}

/** Vue transition hooks for the anchored pet speech/approval surface. */
export function usePetBubbleTransition() {
  const { effectiveMode } = useMotionPreference()
  const tweens = new WeakMap<Element, gsap.core.Tween>()
  const run = (element: Element, enter: boolean, done: () => void): void => {
    tweens.get(element)?.kill()
    const reduced = effectiveMode.value === 'reduced'
    const tween = gsap.to(element, {
      autoAlpha: enter ? 1 : 0,
      scale: reduced ? 1 : enter ? 1 : 0.92,
      xPercent: -50,
      yPercent: -100,
      duration: reduced ? MOTION.micro : MOTION.control,
      ease: enter ? MOTION.easeAgent : MOTION.easeExit,
      overwrite: 'auto',
      onComplete: done,
    })
    tweens.set(element, tween)
  }
  return {
    onBeforeEnter(element: Element) {
      gsap.set(element, {
        autoAlpha: 0,
        scale: effectiveMode.value === 'reduced' ? 1 : 0.92,
        xPercent: -50,
        yPercent: -100,
      })
    },
    onEnter: (element: Element, done: () => void) => run(element, true, done),
    onLeave: (element: Element, done: () => void) => run(element, false, done),
    onCancelled(element: Element) {
      tweens.get(element)?.kill()
      tweens.delete(element)
    },
  }
}
