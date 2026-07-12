<script setup lang="ts">
/**
 * MediaCapabilityGrid：3×2 媒体能力矩阵（理解/生成 × 图片/视频/音频）。
 * 从 BrainsTab 拆出，每个 brain 卡内嵌一份。
 * - 理解行：始终可切换
 * - 生成行：toolCall 关闭时 disabled
 */
import { Check, Microphone, Picture, VideoCamera } from "@element-plus/icons-vue";
import type { MediaCapabilitiesDto } from "@/services/agentApi";

const MEDIA_CAPABILITY_TYPES = [
  { key: "image", label: "图片", icon: Picture },
  { key: "video", label: "视频", icon: VideoCamera },
  { key: "audio", label: "音频", icon: Microphone },
] as const;

defineProps<{
  input: MediaCapabilitiesDto;
  generate: MediaCapabilitiesDto;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle", group: "input" | "generate", kind: keyof MediaCapabilitiesDto): void;
}>();
</script>

<template>
  <div class="capability-matrix" role="group" aria-label="媒体能力矩阵">
    <span class="matrix-corner">媒体能力</span>
    <span v-for="item in MEDIA_CAPABILITY_TYPES" :key="`head-${item.key}`" class="matrix-head">
      {{ item.label }}
    </span>

    <span class="matrix-row-title"><strong>理解</strong><small>输入内容</small></span>
    <button
      v-for="item in MEDIA_CAPABILITY_TYPES"
      :key="`input-${item.key}`"
      type="button"
      class="matrix-cell"
      :class="{ active: input[item.key] === true }"
      :aria-label="`切换${item.label}理解能力`"
      :aria-pressed="input[item.key] === true"
      @click="emit('toggle', 'input', item.key)"
    >
      <component :is="item.icon" class="matrix-icon" />
      <Check class="matrix-check" />
    </button>

    <span class="matrix-row-title"><strong>生成 / 编辑</strong><small>输出内容</small></span>
    <button
      v-for="item in MEDIA_CAPABILITY_TYPES"
      :key="`generate-${item.key}`"
      type="button"
      class="matrix-cell"
      :class="{ active: generate[item.key] === true }"
      :disabled="disabled"
      :aria-label="`切换${item.label}生成与编辑能力`"
      :aria-pressed="generate[item.key] === true"
      @click="emit('toggle', 'generate', item.key)"
    >
      <component :is="item.icon" class="matrix-icon" />
      <Check class="matrix-check" />
    </button>
  </div>
</template>

<style scoped lang="less">
.capability-matrix {
  display: grid;
  grid-template-columns: 112px repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(36, 38, 45, 0.09);
}

.matrix-corner,
.matrix-head,
.matrix-row-title {
  display: flex;
  align-items: center;
  min-width: 0;
}

.matrix-corner {
  color: rgba(20, 22, 26, 0.4);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.matrix-head {
  justify-content: center;
  color: rgba(20, 22, 26, 0.58);
  font-size: 11px;
  font-weight: 700;
}

.matrix-row-title {
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 1px;
  padding-left: 4px;

  strong { color: rgba(20, 22, 26, 0.72); font-size: 11px; }
  small { color: rgba(20, 22, 26, 0.4); font-size: 9px; }
}

.matrix-cell {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  min-height: 36px;
  padding: 4px 6px;
  border: 1px solid rgba(36, 38, 45, 0.1);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.55);
  color: rgba(20, 22, 26, 0.32);
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease, transform 0.12s ease;

  &::before {
    content: "";
    position: absolute;
    inset: -35% auto -35% -45%;
    width: 32%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.72), transparent);
    transform: translateX(-140%) skewX(-16deg);
    transition: transform 0.48s ease;
    pointer-events: none;
  }

  &:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: rgba(190, 132, 28, 0.3);
    background: rgba(246, 183, 60, 0.08);
    color: rgba(128, 86, 10, 0.68);
  }

  &:hover:not(:disabled)::before { transform: translateX(560%) skewX(-16deg); }

  &:hover:not(:disabled) .matrix-icon { transform: rotate(16deg) scale(1.14); }

  &:active:not(:disabled) { transform: translateY(0) scale(0.97); }

  &:focus-visible { outline: 2px solid rgba(246, 183, 60, 0.65); outline-offset: 1px; }

  &.active {
    border-color: rgba(190, 132, 28, 0.34);
    background: linear-gradient(145deg, rgba(255, 247, 222, 0.94), rgba(246, 183, 60, 0.16));
    color: #9a680e;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.45);
  }

  &:disabled { opacity: 0.38; cursor: not-allowed; }
}

.matrix-icon {
  position: relative;
  z-index: 1;
  width: 18px;
  height: 18px;
  transition: transform 0.24s cubic-bezier(0.22, 1.35, 0.36, 1);
}

.matrix-check {
  position: absolute;
  z-index: 2;
  top: 4px;
  right: 4px;
  width: 10px;
  height: 10px;
  padding: 1px;
  border-radius: 50%;
  background: #d99a22;
  color: #fff;
  opacity: 0;
  transform: scale(0.65);
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.matrix-cell.active .matrix-check { opacity: 1; transform: scale(1); }

@media (prefers-reduced-motion: reduce) {
  .matrix-cell,
  .matrix-cell::before,
  .matrix-icon,
  .matrix-check { transition: none; }

  .matrix-cell:hover:not(:disabled),
  .matrix-cell:active:not(:disabled),
  .matrix-cell:hover:not(:disabled) .matrix-icon { transform: none; }

  .matrix-cell::before { display: none; }
}

@media (max-width: 560px) {
  .capability-matrix { grid-template-columns: 84px repeat(3, minmax(0, 1fr)); }
}
</style>
