import { gsap } from 'gsap'
import { reportDisplayFrame } from '@/composables/renderQuality'

/**
 * 动效时长 / 缓动 token 的 GSAP 侧等价数值。
 *
 * 与 `styles/theme.css` 的 `--dur-1/-2/-3`、`--ease-out/--ease-spring` 共用同一组
 * 语义（见 docs/web/motion-standard.md §4.3）：CSS 侧写 bezier，GSAP 侧用等价命名
 * 缓动——`expo.out` ≈ cubic-bezier(0.16,1,0.3,1)，`back.out(1.7)` ≈ cubic-bezier(0.34,1.56,0.64,1)。
 */
export const MOTION = {
  /** --dur-1 0.16s：overlay 遮罩 */
  dur1: 0.16,
  /** --dur-2 0.18s：dialog 面板（gsap.defaults 默认值） */
  dur2: 0.18,
  /** --dur-3 0.24s：drawer / 大面板 */
  dur3: 0.24,
  easeOut: 'expo.out',
  easeSpring: 'back.out(1.7)',
} as const

let installed = false

/**
 * 应用级单例装配（`main.ts` 调用一次）：
 * 1. `gsap.defaults` 落默认时长/缓动，组件内未显式指定的 tween 自动跟随 token 数值；
 * 2. `gsap.ticker` 接入 `reportDisplayFrame`（自适应画质调速器采样显示帧间隔）。
 * 不设 `ticker.fps` 上限——≥30fps 硬约束通过降级裁剪效果实现，不通过降帧率实现。
 */
export function setupGsapCore(): void {
  if (installed) return
  installed = true
  gsap.defaults({ duration: MOTION.dur2, ease: MOTION.easeOut })
  // ticker 回调：time 为累计秒，deltaTime 为毫秒帧间隔
  gsap.ticker.add((time, deltaTime) => {
    reportDisplayFrame(deltaTime, time * 1000)
  })
}
