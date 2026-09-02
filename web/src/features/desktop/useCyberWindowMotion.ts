import { onMounted, onUnmounted, type Ref } from 'vue'
import { gsap } from 'gsap'
import { MOTION } from '@/utils/gsapCore'
import { useMotionPreference } from '@/composables/useMotionPreference'
import { renderQualityProfile, renderQualityTier } from '@/composables/renderQuality'

export interface CyberWindowMotion {
  close: (done: () => void) => void
  focus: () => void
  glitch: () => void
}

export function useCyberWindowMotion(
  root: Readonly<Ref<HTMLElement | null>>,
  opened: () => void,
): CyberWindowMotion {
  let context: gsap.Context | undefined
  let closing = false
  // 动效偏好统一走 useMotionPreference（响应式），不再各自裸查 matchMedia。
  const { effectiveMode } = useMotionPreference()
  const reduced = () => effectiveMode.value === 'reduced'

  onMounted(() => {
    if (!root.value) return
    if (reduced()) {
      gsap.set(root.value, { autoAlpha: 1, x: 0, scale: 1 })
      opened()
      return
    }
    context = gsap.context(() => {
      gsap
        .timeline({ defaults: { overwrite: 'auto' }, onComplete: opened })
        .fromTo(
          root.value,
          { autoAlpha: 0, scaleX: 0.12, scaleY: 0.86, x: -18 },
          { autoAlpha: 1, scaleX: 1, duration: MOTION.panel, ease: 'expo.out' },
        )
        .to(root.value, { scaleY: 1, x: 0, duration: MOTION.micro, ease: 'power3.out' }, '<0.04')
        .fromTo(
          '.cyber-window-scan',
          { xPercent: -115, autoAlpha: 0.8 },
          { xPercent: 115, autoAlpha: 0, duration: MOTION.sweep, ease: 'none' },
          0,
        )
    }, root.value)
  })

  onUnmounted(() => {
    context?.revert()
    context = undefined
  })

  return {
    close(done) {
      if (!root.value || closing) return
      closing = true
      if (reduced()) {
        done()
        return
      }
      context?.add(() => {
        gsap
          .timeline({ onComplete: done })
          .to(root.value, { scaleY: 0.04, duration: MOTION.control, ease: 'power3.in' })
          .to(root.value, { scaleX: 0.08, autoAlpha: 0, duration: MOTION.micro, ease: 'power2.in' })
      })
    },
    focus() {
      if (!root.value || closing) return
      if (reduced()) return
      context?.add(() => {
        gsap.fromTo(
          root.value,
          { '--cyber-focus': 1 },
          { '--cyber-focus': 0, duration: MOTION.sweep, ease: 'power2.out', overwrite: 'auto' },
        )
      })
    },
    glitch() {
      if (!root.value || closing) return
      if (reduced()) return
      context?.add(() => {
        const pixels = renderQualityProfile(renderQualityTier.value).windowGlitchPixels
        gsap
          .timeline({ defaults: { duration: 0.045, ease: 'none' } })
          .to(root.value, { x: -pixels, skewX: -0.8 })
          .to(root.value, { x: pixels, skewX: 0.6 })
          .to(root.value, { x: 0, skewX: 0 })
      })
    },
  }
}
