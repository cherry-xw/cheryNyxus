import { onMounted, onUnmounted } from 'vue'
import { gsap } from 'gsap'
import { MOTION } from '@/utils/gsapCore'

/**
 * 组件级 GSAP 装配（docs/web/motion-standard.md §1.3）：
 * `onMounted` 创建 `gsap.context`（选择器 scope 隔离，未传 scope 时不限定），
 * `onUnmounted` `ctx.revert()` 自动回收全部 tween / listener / 内联样式。
 *
 * setup 内创建的 tween 必须经传入的 context（`ctx.add` 或在回调内直接 `gsap.to`），
 * 禁止绕过 context 创建不被 revert 追踪的 tween。
 */
export function useGsap(
  setup: (ctx: gsap.Context) => void,
  scope?: { value: Element | null },
): void {
  let ctx: gsap.Context | undefined
  onMounted(() => {
    ctx = gsap.context((self) => setup(self), scope?.value ?? undefined)
  })
  onUnmounted(() => {
    ctx?.revert()
    ctx = undefined
  })
}

/** quickTo 写入函数签名（`.tween` 等内部属性保留在 gsap 返回的原对象上，用于清理）。 */
export type QuickToFn = (value: number) => gsap.core.Tween

/**
 * 高频更新用 quickTo 工厂（docs/web/motion-standard.md §1.4）：
 * 首次调用时对当前目标创建 `gsap.quickTo`（单 tween 直写 style），后续调用复用；
 * 卸载时 kill 内部 tween。调用方须保证首次调用发生在目标元素挂载之后。
 */
export function useQuickTo(
  target: () => gsap.TweenTarget,
  property: string,
  vars: gsap.TweenVars = {},
): QuickToFn {
  let quickTo: gsap.QuickToFunc | undefined
  const fn: QuickToFn = (value) => {
    quickTo ??= gsap.quickTo(target(), property, {
      duration: MOTION.dur2,
      ease: MOTION.easeOut,
      ...vars,
    })
    return quickTo(value)
  }
  onUnmounted(() => {
    quickTo?.tween?.kill()
    quickTo = undefined
  })
  return fn
}
