<script setup lang="ts">
/**
 * Ghost 视觉：纯装饰星点，链在主 Agent 身后（运动由 usePetWorld 弹簧跟随首领 trail）。
 * 不显示 name；4px 白核 + 十字渐变射线 = 星星炫光；每实例按 instanceId 哈希异色异步闪烁。
 */
import { computed } from 'vue'
import type { PetInstance } from '../types/types'

const props = defineProps<{
  pet: PetInstance
  style: Record<string, string>
}>()

/** instanceId → 确定性种子：刷新稳定、各 ghost 互异（异步闪烁不同频）。 */
function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 1000
  }
  return Math.abs(h)
}

// 每实例独立闪烁周期与错相延迟（负 delay = 起步即处于循环中段，多颗天然不同频）
const twinkle = computed(() => {
  const seed = hashSeed(props.pet.instanceId)
  const t = (seed % 100) / 100 // 0–1
  const duration = 1.6 + t * 1.8 // 1.6s–3.4s
  const delay = -(t * duration)
  return {
    '--twinkle-duration': `${duration}s`,
    '--twinkle-delay': `${delay}s`,
  } as Record<string, string>
})

const mergedStyle = computed(() => ({ ...props.style, ...twinkle.value }))
</script>

<template>
  <div class="ghost-star-wrap" :style="mergedStyle" :aria-label="`${props.pet.name} 已完成`">
    <span class="ghost-star" aria-hidden="true">
      <span class="ghost-ray ghost-ray--h" />
      <span class="ghost-ray ghost-ray--v" />
      <span class="ghost-core" />
    </span>
  </div>
</template>

<style scoped lang="less">
.ghost-star-wrap {
  position: absolute;
  left: 0;
  top: 0;
  width: 72px; // 保持移动 bbox 对齐（PET_WIDTH），仅视觉缩小
  height: 96px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 12px;
  box-sizing: border-box;
  pointer-events: none;
  user-select: none;
  will-change: transform;
  filter: saturate(1.4) brightness(1.06); // 提鲜：原 pet.color 部分偏灰，星点需更亮
}
.ghost-star {
  position: relative;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: ghost-twinkle var(--twinkle-duration, 2.2s) ease-in-out var(--twinkle-delay, 0s)
    infinite;
}
.ghost-core {
  position: relative;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fff;
  box-shadow:
    0 0 3px 1px var(--pet-color, #8b5cf6),
    0 0 7px 2px color-mix(in srgb, var(--pet-color, #8b5cf6) 72%, transparent);
  z-index: 1;
}
.ghost-ray {
  position: absolute;
  left: 50%;
  top: 50%;
  background: linear-gradient(to right, transparent, var(--pet-color, #8b5cf6), transparent);
  transform-origin: center;
}
.ghost-ray--h {
  width: 26px;
  height: 1.5px;
  transform: translate(-50%, -50%);
}
.ghost-ray--v {
  width: 1.5px;
  height: 26px;
  transform: translate(-50%, -50%);
}
@keyframes ghost-twinkle {
  0%,
  100% {
    opacity: 0.3;
    transform: scale(0.5);
  }
  42% {
    opacity: 1;
    transform: scale(1.06);
  }
  55% {
    opacity: 0.92;
    transform: scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ghost-star {
    animation: none;
  }
}
</style>
