import { computed, type CSSProperties, type ComputedRef } from 'vue'
import { useRenderQuality, type RenderQualityTier } from '@/composables/renderQuality'

/**
 * 动效质量三档效果映射（docs/web/motion-standard.md §3）：
 * 复杂度挂接 `useRenderQuality().tier`，降复杂度不降帧率——不设 ticker.fps 上限，只裁效果。
 */
export interface MotionTierSpec {
  tier: RenderQualityTier
  /** 入场动画形态：full = opacity+y+scale 全量；reduced = opacity+y；opacityOnly = 仅 opacity */
  enter: 'full' | 'reduced' | 'opacityOnly'
  /** 位移/缩放幅度缩放系数（balanced 减半由 CSS var `--motion-amplitude` 控制） */
  amplitude: number
  /** 装饰层（辉光/扫描/流光）：on 全开 / half 幅度减半 / off 隐藏 */
  decoration: 'on' | 'half' | 'off'
  /** stagger 间隔（秒） */
  stagger: number
  /** 消息进入动画开关 */
  messageEnter: boolean
}

const MOTION_TIER_SPECS: Readonly<Record<RenderQualityTier, MotionTierSpec>> = {
  high: {
    tier: 'high',
    enter: 'full',
    amplitude: 1,
    decoration: 'on',
    stagger: 0.04,
    messageEnter: true,
  },
  balanced: {
    tier: 'balanced',
    enter: 'reduced',
    amplitude: 0.5,
    decoration: 'half',
    stagger: 0.02,
    messageEnter: true,
  },
  low: {
    tier: 'low',
    enter: 'opacityOnly',
    amplitude: 0,
    decoration: 'off',
    stagger: 0,
    messageEnter: false,
  },
}

export interface MotionTierState {
  spec: ComputedRef<MotionTierSpec>
  /** 装饰层绑定样式：off 档 display:none；half 档下发幅度 CSS var；on 档为空对象 */
  decorationStyle: ComputedRef<CSSProperties>
}

export function useMotionTier(): MotionTierState {
  const { tier } = useRenderQuality()
  const spec = computed(() => MOTION_TIER_SPECS[tier.value])
  const decorationStyle = computed<CSSProperties>(() => {
    switch (spec.value.decoration) {
      case 'off':
        return { display: 'none' }
      case 'half':
        return { '--motion-amplitude': '0.5' } as CSSProperties
      default:
        return {}
    }
  })
  return { spec, decorationStyle }
}
