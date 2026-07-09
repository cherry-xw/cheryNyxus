<script setup lang="ts">
/**
 * ContextBar：pet 头上 contextUsage 用量 bar（取代原 fatigue bar）。
 * 宽度 = contextUsage(0-1)，颜色：<50% 绿 / 50-80% 黄 / >80% 红。
 * CP2 字段默认 0（不生效，后端 contextUsage 计算暂缓）；组件就位可渲染。
 */
import { computed } from "vue";

const props = defineProps<{
  usage: number; // 0-1
}>();

const COLORS = {
  low: "#22c55e", // <50% 绿
  mid: "#eab308", // 50-80% 黄
  high: "#ef4444", // >80% 红
} as const;

const clamped = computed(() => Math.min(1, Math.max(0, props.usage)));
const color = computed(() => {
  if (clamped.value >= 0.8) return COLORS.high;
  if (clamped.value >= 0.5) return COLORS.mid;
  return COLORS.low;
});
const widthPct = computed(() => `${clamped.value * 100}%`);
const ariaValuenow = computed(() => Math.round(clamped.value * 100));
</script>

<template>
  <div
    class="context-bar"
    role="progressbar"
    :aria-valuenow="ariaValuenow"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="`context usage ${ariaValuenow}%`"
  >
    <span class="fill" :style="{ width: widthPct, background: color }" />
  </div>
</template>

<style scoped lang="less">
.context-bar {
  position: relative;
  width: 44px;
  height: 2px;
  border-radius: 1px;
  background: rgba(20, 22, 26, 0.14);
  overflow: hidden;
}

.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 1px;
  transition:
    width 200ms ease,
    background 200ms ease;
}
</style>
