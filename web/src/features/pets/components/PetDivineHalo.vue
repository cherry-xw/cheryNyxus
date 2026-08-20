<script setup lang="ts">
/**
 * PetDivineHalo：中心橄榄球光晕 + 独立叶脉式光刺。
 * 光刺参数由确定性噪声生成，保证各 pet 视觉一致且不会在重渲染时跳变。
 */
defineProps<{
  active?: boolean
}>()

const RAY_COUNT = 68
const MAX_RAY_LENGTH = 47

function noise(index: number, salt: number): number {
  const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453
  return value - Math.floor(value)
}

const RAYS = Array.from({ length: RAY_COUNT }, (_, index) => {
  const angle = (index * 360) / RAY_COUNT + (noise(index, 1) - 0.5) * 3.4
  const radians = (angle * Math.PI) / 180
  const horizontal = Math.abs(Math.sin(radians))
  const vertical = Math.abs(Math.cos(radians))

  // 从椭圆光圈的可见边缘再探出 3~8px：能穿出虚化光圈，但不会形成过长尖刺。
  const ellipseRadius = 1 / Math.sqrt((horizontal / 39) ** 2 + (vertical / 18) ** 2)
  const length = Math.min(MAX_RAY_LENGTH, ellipseRadius + 4 + noise(index, 2) * 5)
  // 每根光线在最清晰阶段都会越过光圈，末端仅再轻微探出，避免过长。
  const reach = 0.94 + noise(index, 3) * 0.06
  const finalReach = Math.min(1.04, 0.98 + noise(index, 4) * 0.06)
  const direction = noise(index, 5) > 0.5 ? 1 : -1
  const drift = direction * (0.7 + noise(index, 6) * 2.4)
  const duration = 3.1 + noise(index, 7) * 2.3
  const peakOpacity = 0.42 + noise(index, 8) * 0.38

  return {
    angle,
    midAngle: angle + drift * 0.56,
    finalAngle: angle + drift,
    length,
    reach,
    finalReach,
    width: 0.65 + noise(index, 9) * 0.85,
    duration,
    delay: -duration * noise(index, 10),
    peakOpacity,
    fadeOpacity: peakOpacity * (0.3 + noise(index, 11) * 0.25),
  }
})

function rayStyle(ray: (typeof RAYS)[number]) {
  return {
    '--ray-angle': `${ray.angle.toFixed(2)}deg`,
    '--ray-mid-angle': `${ray.midAngle.toFixed(2)}deg`,
    '--ray-final-angle': `${ray.finalAngle.toFixed(2)}deg`,
    '--ray-length': `${ray.length.toFixed(2)}px`,
    '--ray-reach': ray.reach.toFixed(3),
    '--ray-final-reach': ray.finalReach.toFixed(3),
    '--ray-width': `${ray.width.toFixed(2)}px`,
    '--ray-duration': `${ray.duration.toFixed(2)}s`,
    '--ray-delay': `${ray.delay.toFixed(2)}s`,
    '--ray-peak-opacity': ray.peakOpacity.toFixed(3),
    '--ray-fade-opacity': ray.fadeOpacity.toFixed(3),
  }
}
</script>

<template>
  <span class="divine-halo" :class="{ 'is-active': active }" aria-hidden="true">
    <span class="ray-field">
      <i v-for="(ray, index) in RAYS" :key="index" class="light-ray" :style="rayStyle(ray)" />
    </span>
    <span class="olive-core" />
  </span>
</template>

<style scoped lang="less">
.divine-halo {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 0;
  width: 112px;
  height: 62px;
  pointer-events: none;
  transform: translate(-50%, -50%);
  opacity: 0.94;
}

.ray-field,
.olive-core {
  position: absolute;
  inset: 0;
}

.ray-field {
  z-index: 0;
}

.olive-core {
  z-index: 1;
  left: 50%;
  top: 50%;
  width: 92px;
  height: 42px;
  border-radius: 50%;
  background: radial-gradient(
    ellipse at center,
    var(--aura-center) 0%,
    var(--aura-center) 12%,
    var(--aura-mid) 38%,
    var(--aura-edge) 63%,
    transparent 78%
  );
  filter: drop-shadow(0 0 6px var(--aura-shadow));
  transform: translate(-50%, -50%);
  animation: core-breathe 4.2s ease-in-out infinite;
}

.light-ray {
  position: absolute;
  left: 50%;
  bottom: 50%;
  width: var(--ray-width);
  height: var(--ray-length);
  border-radius: 52% 52% 34% 34%;
  background: linear-gradient(
    to top,
    transparent 0%,
    color-mix(in srgb, var(--aura-ray) 48%, transparent) 16%,
    var(--aura-ray) 48%,
    color-mix(in srgb, var(--aura-ray) 32%, transparent) 76%,
    transparent 100%
  );
  color: var(--aura-vein);
  clip-path: polygon(40% 100%, 60% 100%, 72% 38%, 50% 0, 28% 38%);
  filter: blur(0.25px) drop-shadow(0 0 1px var(--aura-ray));
  opacity: 0;
  transform: translateX(-50%) rotate(var(--ray-angle)) scaleY(0.04);
  transform-origin: 50% 100%;
  animation: ray-bloom var(--ray-duration) ease-out var(--ray-delay) infinite;

  &::after {
    position: absolute;
    left: 50%;
    bottom: 2%;
    width: 0.35px;
    height: 92%;
    background: linear-gradient(
      to top,
      transparent 0%,
      currentColor 24%,
      currentColor 62%,
      transparent 100%
    );
    box-shadow: 0 0 1px currentColor;
    content: '';
    transform: translateX(-50%);
  }
}

.is-active {
  .olive-core {
    animation-duration: 3.2s;
  }

  .light-ray {
    filter: blur(0.2px) drop-shadow(0 0 1.4px var(--aura-ray));
  }
}

@keyframes core-breathe {
  0%,
  100% {
    opacity: 0.64;
    transform: translate(-50%, -50%) scale(0.98);
  }
  50% {
    opacity: 0.8;
    transform: translate(-50%, -50%) scale(1.025);
  }
}

@keyframes ray-bloom {
  0% {
    opacity: 0;
    filter: blur(0.9px) drop-shadow(0 0 1px var(--aura-ray));
    transform: translateX(-50%) rotate(var(--ray-angle)) scaleY(0.04);
  }
  16% {
    opacity: 0.18;
  }
  44% {
    opacity: var(--ray-peak-opacity);
    filter: blur(0.25px) drop-shadow(0 0 1.5px var(--aura-ray));
    transform: translateX(-50%) rotate(var(--ray-mid-angle)) scaleY(var(--ray-reach));
  }
  72% {
    opacity: var(--ray-fade-opacity);
  }
  100% {
    opacity: 0;
    filter: blur(1.35px) drop-shadow(0 0 3px var(--aura-ray));
    transform: translateX(-50%) rotate(var(--ray-final-angle)) scaleY(var(--ray-final-reach));
  }
}

@media (prefers-reduced-motion: reduce) {
  .olive-core,
  .light-ray {
    animation: none;
  }

  .light-ray {
    opacity: 0.34;
    filter: blur(0.45px);
    transform: translateX(-50%) rotate(var(--ray-angle)) scaleY(var(--ray-reach));
  }
}
</style>
