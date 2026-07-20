<script setup lang="ts">
import type { PetInstance } from '../types/types'

defineProps<{
  pet: PetInstance
  style: Record<string, string>
}>()
</script>

<template>
  <div class="ghost-dot-wrap" :style="style" :aria-label="`${pet.name} 已完成`">
    <span class="ghost-dot" aria-hidden="true" />
    <span class="ghost-name" :title="pet.name">{{ pet.name }}</span>
  </div>
</template>

<style scoped lang="less">
.ghost-dot-wrap {
  position: absolute;
  left: 0;
  top: 0;
  width: 72px;
  height: 96px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  padding-bottom: 8px;
  box-sizing: border-box;
  pointer-events: none;
  user-select: none;
  will-change: transform;
}
.ghost-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--pet-color, #8b5cf6);
  box-shadow:
    0 0 5px var(--pet-color, #8b5cf6),
    0 0 13px var(--pet-color, #8b5cf6),
    0 0 24px color-mix(in srgb, var(--pet-color, #8b5cf6) 62%, transparent);
  animation: ghost-pulse 2.2s ease-in-out infinite;
}
.ghost-name {
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.62);
  color: rgba(20, 22, 26, 0.68);
  font-size: 8px;
  line-height: 1.3;
  text-align: center;
}
@keyframes ghost-pulse {
  0%,
  100% {
    opacity: 0.5;
    transform: scale(0.82);
    filter: brightness(0.9);
  }
  48% {
    opacity: 1;
    transform: scale(1.16);
    filter: brightness(1.25);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ghost-dot {
    animation: none;
  }
}
</style>
