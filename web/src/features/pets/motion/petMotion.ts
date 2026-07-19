import type { PetAction, PetMood } from '../types/types'

/**
 * motion-v variant helpers。返回 { animate, transition }，由 PetSprite 绑定到
 * <Motion :animate :transition>。不导入 motion-v 类型——返回类型全靠字面量推断，
 * ease/repeatType 用 as const 保证 Easing/RepeatType 字面量兼容。
 */

type Side = 'left' | 'right'

// tween 循环 transition（字面量推断，ease/repeatType 为字面量类型）
const tLoop = (
  duration: number,
  repeatType?: 'reverse' | 'loop' | 'mirror',
  ease: 'easeInOut' | 'easeOut' = 'easeInOut',
) => ({
  duration,
  repeat: Infinity,
  ease,
  ...(repeatType ? { repeatType } : {}),
})

const tSpring = (stiffness: number, damping: number) => ({
  type: 'spring' as const,
  stiffness,
  damping,
  repeat: Infinity,
  repeatType: 'reverse' as const,
})

// --- sprite 主体动作 ---
export function spriteMotion(action: PetAction) {
  switch (action) {
    case 'walk':
      return { animate: { y: [0, -3, 0], rotate: [-1, 1, -1] }, transition: tLoop(2) }
    case 'idle':
      return { animate: { y: [0, -2, 0] }, transition: tLoop(2.6) }
    case 'hover':
      return { animate: { rotate: [-2, 3], y: [-2, -3] }, transition: tLoop(0.9, 'reverse') }
    case 'dragging':
      return {
        animate: { rotate: [-4, 4], scaleX: [1.03, 0.98] },
        transition: tLoop(0.72, 'reverse'),
      }
    case 'dropped':
      return {
        animate: { y: [0, -3, 0], rotate: [-3, 3, -3] },
        transition: tLoop(0.76, 'reverse', 'easeOut'),
      }
    case 'clicked':
      return {
        animate: { y: [0, -4, 0], scaleY: [0.98, 1.03, 0.98] },
        transition: tSpring(300, 12),
      }
    case 'chatting':
      return { animate: { y: [0, -2, 0], rotate: [-2, 1, -2] }, transition: tLoop(1.1) }
    case 'sleep':
      // 静止微呼吸（速度 0，仅极轻 y/rotate 起伏）
      return { animate: { y: [0, -1, 0], rotate: [-0.5, 0.5, -0.5] }, transition: tLoop(3) }
    default:
      return { animate: { y: [0, -2, 0] }, transition: tLoop(2.6) }
  }
}

/** 灵魂态 sprite 主体动作：缓慢上下飘动（不走 action 驱动的 walk/idle 摇摆）。 */
export function ghostSpriteMotion() {
  return { animate: { y: [0, -3, 0] }, transition: tLoop(3.2) }
}

// --- 手部摆动（左右镜像，左取负） ---
const HAND_ROTATE: Record<PetAction, number[]> = {
  walk: [-12, 12, -12],
  idle: [-4, 4, -4],
  hover: [0, 25, 0],
  dragging: [-25, 25, -25],
  dropped: [-20, 20, -20],
  clicked: [0, 30, 0],
  chatting: [0, 12, 0],
  sleep: [0, 0, 0],
}

export function handMotion(action: PetAction, side: Side) {
  const base = HAND_ROTATE[action] ?? HAND_ROTATE.idle
  const rotate = side === 'left' ? base.map((v) => -v) : base
  const dur =
    action === 'clicked' || action === 'dragging'
      ? 0.5
      : action === 'hover'
        ? 0.6
        : action === 'chatting'
          ? 0.9
          : action === 'sleep'
            ? 3
            : 1
  return { animate: { rotate }, transition: tLoop(dur, 'reverse') }
}

// --- 表情（face）动画：几何 + 滤镜（动态表情的颜色动画下沉到 face；filter 对 emoji/颜文字均生效） ---
export function faceMotion(mood: PetMood) {
  switch (mood) {
    case 'happy':
      return {
        animate: {
          scale: [1, 1.1, 1],
          filter: ['brightness(1)', 'brightness(1.22)', 'brightness(1)'],
        },
        transition: tLoop(1.4),
      }
    case 'angry':
      return {
        animate: {
          rotate: [-3, 3, -3],
          filter: ['brightness(1)', 'brightness(1.35)', 'brightness(1)'],
        },
        transition: tLoop(0.6),
      }
    case 'panicked':
      return {
        animate: {
          rotate: [-4, 4, -4],
          filter: ['hue-rotate(0deg)', 'hue-rotate(40deg)', 'hue-rotate(0deg)'],
        },
        transition: tLoop(0.5),
      }
    case 'surprised':
      return {
        animate: {
          scale: [1, 1.12, 1],
          filter: ['brightness(1)', 'brightness(1.5)', 'brightness(1)'],
        },
        transition: tLoop(0.4),
      }
    case 'sad':
      return {
        animate: {
          scale: [1, 0.98, 1],
          opacity: [1, 0.6, 1],
          filter: ['brightness(1)', 'brightness(0.72)', 'brightness(1)'],
        },
        transition: tLoop(2.4),
      }
    case 'sleepy':
      return { animate: { scale: [1, 0.96, 1], opacity: [1, 0.55, 1] }, transition: tLoop(2.8) }
    default:
      // calm / serious / curious / nagging：缓慢呼吸
      return {
        animate: { scale: [1, 1.08, 1] },
        transition: {
          duration: 2.4,
          repeat: Infinity,
          ease: 'easeInOut' as const,
          times: [0, 0.9, 1],
        },
      }
  }
}

/** 灵魂态 face 动作：极轻呼吸（不走 mood 驱动的闪烁/滤镜动画）。 */
export function ghostFaceMotion() {
  return { animate: { scale: [1, 1.05, 1] }, transition: tLoop(3.6) }
}

// --- 气泡进退 ---
// x:"-50%" y:"-100%" 为定位（非动画）：水平居中 + 上移自身高度，使气泡底部对齐
// 锚点（pet 顶部中心）。气泡脱离 .pet 容器（.pet-wrap 兄弟），需自定位。
// 进退动效靠 opacity + scale（transform-origin: center bottom → 从下弹出）。
export function speechMotion() {
  return {
    initial: { opacity: 0, scale: 0.86, x: '-50%', y: '-100%' },
    animate: { opacity: 1, scale: 1, x: '-50%', y: '-100%' },
    exit: { opacity: 0, scale: 0.86, x: '-50%', y: '-100%' },
    transition: { duration: 0.18, ease: 'easeOut' as const },
  }
}
