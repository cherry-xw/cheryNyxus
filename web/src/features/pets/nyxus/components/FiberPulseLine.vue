<script setup lang="ts">
/**
 * FiberPulseLine：光纤光束模块（独立深度调试用）。
 *
 * 视觉：低亮轴突（静态）+ 沿路径定向传导的紧凑波前与短尾焰。
 *
 * 实现：路径方向就是传播方向；短尾和领先波头使用不同相位，不再用反向几何叠长虚线。
 *
 * 调参：dur=光束冲击周期(s)，越短越急促（光速感）。
 */
import { computed } from 'vue'

interface Props {
  d: string
  /** 可选脉冲几何；默认与静态总线同向。 */
  pulseD?: string
  color: string
  /** 波前高亮色；底层纤维继续使用 color 保持拓扑辨识。 */
  pulseColor?: string
  dur?: number
  /** 稳定相位偏移：让每条边独立出现脉冲而非同帧起跑。 */
  delay?: number
  /** 非活动边仅保留清晰的静态纤维。 */
  active?: boolean
  kind?: string
  repeatCount?: '1' | 'indefinite'
}
const props = withDefaults(defineProps<Props>(), {
  dur: 1.1,
  repeatCount: 'indefinite',
})
const durS = computed(() => props.dur.toFixed(2) + 's')
const delayS = computed(() => (props.delay ?? 0).toFixed(2) + 's')
const pulseStroke = computed(() => props.pulseColor ?? props.color)
</script>

<template>
  <g class="fiber" :class="[`kind-${kind ?? 'sequence'}`, { 'is-active': active }]">
    <!-- 双层静态总线：外层微光 + 内层轴突。 -->
    <path class="fiber-bus" :d="d" :stroke="color" />
    <path class="fiber-core" :d="d" :stroke="color" />
    <!-- tail：短、低亮的拖曳尾焰；负 dashoffset 沿 path 正方向前进。 -->
    <path v-if="active" class="fiber-tail" :d="pulseD ?? d" :stroke="pulseStroke" pathLength="100">
      <animate
        attributeName="stroke-dashoffset"
        :dur="durS"
        :begin="delayS"
        values="0;-100"
        :repeatCount="repeatCount"
      />
      <animate
        attributeName="opacity"
        :dur="durS"
        :begin="delayS"
        values="0;0.42;0.2;0"
        keyTimes="0;0.1;0.86;1"
        :repeatCount="repeatCount"
      />
    </path>
    <!-- wavefront：相对尾焰领先 11 个 pathLength 单位的短促亮点。 -->
    <path
      v-if="active"
      class="fiber-wavefront"
      :d="pulseD ?? d"
      :stroke="pulseStroke"
      pathLength="100"
    >
      <animate
        attributeName="stroke-dashoffset"
        :dur="durS"
        :begin="delayS"
        values="-11;-111"
        :repeatCount="repeatCount"
      />
      <animate
        attributeName="opacity"
        :dur="durS"
        :begin="delayS"
        values="0;1;0.82;0"
        keyTimes="0;0.1;0.84;1"
        :repeatCount="repeatCount"
      />
    </path>
  </g>
</template>

<style scoped lang="less">
.fiber-bus {
  fill: none;
  stroke-width: 4.5;
  stroke-linecap: round;
  opacity: 0.14;
  filter: url(#nx-glow-soft);
}
.fiber-core {
  fill: none;
  stroke-width: 1.25;
  stroke-linecap: round;
  opacity: 0.78;
}
.fiber.is-active .fiber-core { stroke-width: 1.7; opacity: 0.92; }
.fiber.kind-dispatch .fiber-core { stroke-dasharray: 5 4; }
.fiber.kind-continue .fiber-core { stroke-dasharray: 10 3; }
.fiber.kind-return-continuation .fiber-core { stroke-dasharray: 8 3 2 3; }
.fiber-tail {
  fill: none;
  stroke-width: 2.8;
  stroke-linecap: round;
  stroke-dasharray: 12 88;
  filter: url(#nx-glow-soft);
}
.fiber-wavefront {
  fill: none;
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-dasharray: 2.8 97.2;
  filter: url(#nx-glow);
}

@media (prefers-reduced-motion: reduce) {
  .fiber-tail,
  .fiber-wavefront {
    display: none;
  }
}
</style>
