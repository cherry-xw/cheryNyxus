<script setup lang="ts">
/**
 * TabIcon：设置页签行图标（Morphicons 方案）。
 *
 * 与工作台运行图的 WorkflowMorphIcon 同一渲染体系：MorphIcon 接收 lucide 图标数据，
 * 随动效分级（useMotionTier）决定是否播放变形动画；这里页签图标固定不切换，
 * 主要复用同一套描边风格与 reduce-motion 策略。
 */
import { computed } from 'vue'
import { MorphIcon, type IconInput } from 'morphicons/vue'
import { useMotionTier } from '@/composables/useMotionTier'

withDefaults(
  defineProps<{
    icon: IconInput
    size?: number
  }>(),
  { size: 15 },
)

const { spec } = useMotionTier()
const reducedMotion = computed(() =>
  spec.value.mode === 'full' && spec.value.decoration !== 'off' ? 'user' : 'always',
)
</script>

<template>
  <MorphIcon
    :icon="icon"
    :size="size"
    :stroke-width="1.8"
    :reduced-motion="reducedMotion"
    aria-hidden="true"
  />
</template>
