import { gsap } from 'gsap'

/**
 * 动效时长 / 缓动 token 的 GSAP 侧等价数值。
 *
 * 与 `styles/theme.css` 的 `--dur-1/-2/-3`、`--ease-out/--ease-spring` 共用同一组
 * 语义（见 docs/web/motion-standard.md §4.3）：CSS 侧写 bezier，GSAP 侧用等价命名
 * 缓动——`expo.out` ≈ cubic-bezier(0.16,1,0.3,1)，`back.out(1.7)` ≈ cubic-bezier(0.34,1.56,0.64,1)。
 */
export const MOTION = {
  feedback: 0.08,
  micro: 0.12,
  control: 0.16,
  panel: 0.22,
  view: 0.28,
  sweep: 0.42,
  easeMicro: 'power2.out',
  easePanel: 'power3.out',
  easeExit: 'power2.in',
  easeAgent: 'back.out(1.25)',
} as const

let installed = false

/**
 * 应用级单例装配（`main.ts` 调用一次）：
 * 只设置运行时安全项。时长与缓动必须由语义预设显式给出，避免全局默认值让
 * 不同交互被意外压成同一种节奏。显示帧采样由按需 frameCoordinator 负责，
 * 这里不得注册永久 ticker listener，否则 GSAP 无法 autoSleep。
 */
export function setupGsapCore(): void {
  if (installed) return
  installed = true
  gsap.config({ autoSleep: 120, force3D: 'auto', nullTargetWarn: true })
}
