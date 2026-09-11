<script setup lang="ts">
import { computed } from 'vue'
import { MorphIcon, type IconInput } from 'morphicons/vue'
import { useMotionTier } from '@/composables/useMotionTier'

withDefaults(
  defineProps<{
    icon: IconInput
    statusIcon?: IconInput
    label?: string
    size?: number
  }>(),
  { statusIcon: undefined, label: undefined, size: 22 },
)
const { spec } = useMotionTier()
const reducedMotion = computed(() =>
  spec.value.mode === 'full' && spec.value.decoration !== 'off' ? 'user' : 'always',
)
</script>

<template>
  <span class="workflow-morph-icon" :aria-label="label">
    <MorphIcon
      :icon="icon"
      :size="size"
      :stroke-width="1.8"
      :reduced-motion="reducedMotion"
      spring="smooth"
      aria-hidden="true"
    />
    <MorphIcon
      v-if="statusIcon"
      class="workflow-morph-status"
      :icon="statusIcon"
      :size="8"
      :stroke-width="1.5"
      :reduced-motion="reducedMotion"
      spring="snappy"
      aria-hidden="true"
    />
  </span>
</template>

<style scoped lang="less">
.workflow-morph-icon {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  color: inherit;
}
.workflow-morph-status {
  position: absolute;
  right: -2px;
  top: -2px;
  color: currentColor;
}
</style>
