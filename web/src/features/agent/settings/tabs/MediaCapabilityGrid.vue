<script setup lang="ts">
/**
 * MediaCapabilityGrid：一行横排媒体能力选择。
 * 两个标题组（理解 / 生成），每组 3 个 icon。
 * 每项默认 element-plus icon，active 切 emoji（3D flip 卡翻转动画）。
 */
import { Microphone, Picture, VideoCamera } from "@element-plus/icons-vue";
import type { Component } from "vue";
import type { MediaCapabilitiesDto } from "@/services/agentApi";

type Kind = keyof MediaCapabilitiesDto;

const MEDIA_CAPS: readonly { key: Kind; inputEmoji: string; generateEmoji: string; icon: Component }[] = [
  { key: "image", inputEmoji: "🖼️", generateEmoji: "🎨", icon: Picture },
  { key: "video", inputEmoji: "🎞️", generateEmoji: "🎬", icon: VideoCamera },
  { key: "audio", inputEmoji: "🔊", generateEmoji: "🎵", icon: Microphone },
];

defineProps<{
  input: MediaCapabilitiesDto;
  generate: MediaCapabilitiesDto;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle", group: "input" | "generate", kind: Kind): void;
}>();
</script>

<template>
  <div class="cap-row" role="group" aria-label="媒体能力">
    <div class="cap-group">
      <div class="cap-group-head">
        <strong>理解</strong>
        <small>输入</small>
      </div>
      <button
        v-for="cap in MEDIA_CAPS"
        :key="`input-${cap.key}`"
        type="button"
        class="cap-item"
        :class="{ active: input[cap.key] === true }"
        :aria-label="`切换${cap.key}理解能力`"
        :aria-pressed="input[cap.key] === true"
        @click="emit('toggle', 'input', cap.key)"
      >
        <span class="cap-face cap-front">
          <component :is="cap.icon" class="cap-icon" />
        </span>
        <span class="cap-face cap-back">{{ cap.inputEmoji }}</span>
      </button>
    </div>

    <div class="cap-group">
      <div class="cap-group-head">
        <strong>生成</strong>
        <small>输出</small>
      </div>
      <button
        v-for="cap in MEDIA_CAPS"
        :key="`generate-${cap.key}`"
        type="button"
        class="cap-item"
        :class="{ active: generate[cap.key] === true }"
        :disabled="disabled"
        :aria-label="`切换${cap.key}生成与编辑能力`"
        :aria-pressed="generate[cap.key] === true"
        @click="emit('toggle', 'generate', cap.key)"
      >
        <span class="cap-face cap-front">
          <component :is="cap.icon" class="cap-icon" />
        </span>
        <span class="cap-face cap-back">{{ cap.generateEmoji }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="less">
.cap-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(36, 38, 45, 0.09);
}

.cap-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cap-group-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding-right: 2px;

  strong { color: rgba(20, 22, 26, 0.72); font-size: 11px; line-height: 1.1; }
  small { color: rgba(20, 22, 26, 0.4); font-size: 9px; line-height: 1.1; }
}

.cap-item {
  position: relative;
  width: 24px;
  height: 24px;
  border: 1px solid rgba(36, 38, 45, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  perspective: 220px;
  transform-style: preserve-3d;
  transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;

  &:hover:not(:disabled) {
    border-color: rgba(190, 132, 28, 0.3);
    background: rgba(246, 183, 60, 0.08);
  }

  &:active:not(:disabled) { transform: scale(0.96); }

  &:focus-visible { outline: 2px solid rgba(246, 183, 60, 0.65); outline-offset: 1px; }

  &:disabled { opacity: 0.38; cursor: not-allowed; }

  &.active {
    border-color: rgba(190, 132, 28, 0.34);
    background: linear-gradient(145deg, rgba(255, 247, 222, 0.94), rgba(246, 183, 60, 0.16));
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.45);
  }
}

.cap-face {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  border-radius: 5px;
  transition: transform 0.42s cubic-bezier(0.22, 1.35, 0.36, 1);
  transform-style: preserve-3d;
}

.cap-front {
  transform: rotateY(0deg);
  color: rgba(20, 22, 26, 0.52);
}

.cap-back {
  transform: rotateY(-180deg);
  font-size: 13px;
  line-height: 1;
}

.cap-item.active .cap-front { transform: rotateY(180deg); }
.cap-item.active .cap-back { transform: rotateY(0deg); }

.cap-icon {
  width: 13px;
  height: 13px;
}

@media (prefers-reduced-motion: reduce) {
  .cap-face,
  .cap-item { transition: none; }
  .cap-item:active:not(:disabled) { transform: none; }
}

@media (max-width: 560px) {
  .cap-row { flex-wrap: wrap; gap: 8px; }
  .cap-item { width: 22px; height: 22px; }
}
</style>
