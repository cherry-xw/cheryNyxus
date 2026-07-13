<script setup lang="ts">
/**
 * PetBody：宠物身体视觉组件（纯展示 + 交互事件上传）。
 * 包含 shadow / dir / sprite / status-row / head-row（hands + face-flip 3D card + meta-row）/ zzz / busy-indicator。
 * 所有 drag/hover/click handler 由父组件传入（usePetDrag）。
 */
import { motion } from "motion-v";
import type { VariantType } from "motion-v";
import ContextBar from "@/features/agent/ContextBar.vue";
import PetToolbar from "@/features/agent/PetToolbar.vue";
import RunningTools from "@/features/agent/RunningTools.vue";
import type { PetInstance } from "./types";
import type { RunningTool } from "@/stores/agents";

const MotionSpan = motion.span;

defineProps<{
  pet: PetInstance;
  paused: boolean;
  classes: unknown[];
  style: Record<string, string>;
  faceGlyph: string;
  leftHand: string;
  rightHand: string;
  nameChars: string[];
  sprite: { animate: VariantType; transition: VariantType["transition"] };
  face: { animate: VariantType; transition: VariantType["transition"] };
  leftHandMotion: { animate: VariantType; transition: VariantType["transition"] };
  rightHandMotion: { animate: VariantType; transition: VariantType["transition"] };
  runningTools: RunningTool[];
  isBusy: boolean;
}>();

const emit = defineEmits<{
  history: [pet: PetInstance];
  abort: [pet: PetInstance];
  destroy: [pet: PetInstance];
  compact: [pet: PetInstance];
  resume: [pet: PetInstance];
  pointerDown: [event: PointerEvent];
  pointerMove: [event: PointerEvent];
  endPointer: [event: PointerEvent];
  headRowEnter: [];
  headRowLeave: [event: PointerEvent];
  clickPet: [pet: PetInstance];
}>();
</script>

<template>
  <div
    class="pet"
    :class="classes"
    :style="style"
  >
    <span class="shadow" />
    <span class="dir">
      <MotionSpan
        class="sprite"
        :initial="false"
        :animate="sprite.animate"
        :transition="sprite.transition"
      >
        <div v-if="!pet.isGhost" class="status-row" :aria-label="`emotion ${Math.round(pet.emotion)}, context ${Math.round(pet.contextUsage * 100)}%`">
          <span class="stat emotion"><span class="fill" :style="{ width: `${pet.emotion}%` }" /></span>
          <ContextBar :usage="pet.contextUsage" />
        </div>
        <span
          class="head-row"
          role="button"
          tabindex="0"
          :aria-label="`${pet.name} pet`"
          @pointerdown="(e: PointerEvent) => emit('pointerDown', e)"
          @pointermove="(e: PointerEvent) => emit('pointerMove', e)"
          @pointerup="(e: PointerEvent) => emit('endPointer', e)"
          @pointercancel="(e: PointerEvent) => emit('endPointer', e)"
          @pointerenter="emit('headRowEnter')"
          @pointerleave="(e: PointerEvent) => emit('headRowLeave', e)"
          @click.stop="emit('clickPet', pet)"
          @keydown.enter.space.prevent="emit('clickPet', pet)"
        >
          <MotionSpan
            v-if="!pet.isGhost"
            class="hand hand-left"
            aria-hidden="true"
            :initial="false"
            :animate="leftHandMotion.animate"
            :transition="leftHandMotion.transition"
          >{{ leftHand }}</MotionSpan>
          <span class="face-flip">
            <span class="face-rotate">
              <span class="face-side front">
                <MotionSpan
                  class="face"
                  :initial="false"
                  :animate="face.animate"
                  :transition="face.transition"
                >{{ faceGlyph }}</MotionSpan>
              </span>
              <span class="face-side back">
                <MotionSpan
                  class="face"
                  :initial="false"
                  :animate="face.animate"
                  :transition="face.transition"
                >{{ faceGlyph }}</MotionSpan>
              </span>
            </span>
          </span>
          <MotionSpan
            v-if="!pet.isGhost"
            class="hand hand-right"
            aria-hidden="true"
            :initial="false"
            :animate="rightHandMotion.animate"
            :transition="rightHandMotion.transition"
          >{{ rightHand }}</MotionSpan>
        </span>
        <div class="meta-row" :class="{ 'has-running': runningTools.length }">
          <span class="name">
            <span
              v-for="(ch, i) in nameChars"
              :key="i"
              class="char"
              :style="{ '--char-i': i }"
            >{{ ch }}</span>
          </span>
          <PetToolbar
            v-if="!pet.isGhost"
            :pet="pet"
            @history="emit('history', pet)"
            @abort="emit('abort', pet)"
            @destroy="emit('destroy', pet)"
            @compact="emit('compact', pet)"
            @resume="emit('resume', pet)"
          />
          <RunningTools v-if="!pet.isGhost" :tools="runningTools" />
        </div>
      </MotionSpan>
    </span>
    <span v-if="pet.action === 'sleep'" class="zzz" aria-hidden="true">{{ pet.sleep?.zzz ?? "zZ" }}</span>
    <span v-if="pet.action === 'sleep'" class="zzz" aria-hidden="true">{{ pet.sleep?.zzz ?? "zZ" }}</span>
    <!-- busy-indicator：自定义 SVG 双圆环 loader；显隐走 isBusy（与气泡显示 hasStream 解耦）。 -->
    <svg
      v-if="isBusy && !pet.isGhost"
      class="busy-indicator"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-label="忙碌中"
    >
      <circle class="busy-ring" cx="12" cy="12" r="9" fill="none" stroke-width="2" />
      <circle class="busy-arc" cx="12" cy="12" r="5" fill="none" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;
@glyph-fonts: ui-rounded, "Hiragino Sans", "PingFang SC", "Noto Sans Symbols 2",
  "Noto Sans Symbols", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif;
@tribe-border: hsl(var(--tribe-hue) 60% 82%);
@tribe-bg: hsl(var(--tribe-hue) 60% 94%);
@tribe-ink: hsl(var(--tribe-hue) 50% 28%);

.glyph-font() {
  font-family: @glyph-fonts;
}

.pet {
  --pet-color: #f6b73c;
  --pet-accent: #3b2b12;
  --pet-direction: 1;
  position: absolute;
  left: 0;
  top: 0;
  z-index: 1;
  width: 72px;
  height: 96px;
  border-radius: 8px;
  color: var(--pet-accent);
  user-select: none;
  transition:
    filter 180ms ease,
    opacity 180ms ease;
  will-change: transform;

  &.is-dragging {
    filter: drop-shadow(0 12px 18px rgba(0, 0, 0, 0.24));
    .head-row { cursor: grabbing; }
  }

  &.is-master .name {
    border-color: @tribe-border;
    background: @tribe-bg;
    .char {
      color: hsl(0 85% 55%);
      animation: rainbow-char 3s linear infinite;
      animation-delay: calc(var(--char-i, 0) * 0.2s);
    }
  }

  &.is-sub .name {
    border-color: @tribe-border;
    background: @tribe-bg;
    color: @tribe-ink;
  }

  &.is-paused { opacity: 0.78; }

  &.is-ghost {
    opacity: 0.75;
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.5)) drop-shadow(0 0 8px rgba(255, 255, 255, 0.6));
    pointer-events: none;
    .head-row {
      cursor: pointer;
      pointer-events: auto;
      min-width: 0;
      min-height: 0;
    }
  }
}

@keyframes rainbow-char {
  0% { color: hsl(0 85% 55%); }
  17% { color: hsl(60 85% 55%); }
  33% { color: hsl(120 85% 55%); }
  50% { color: hsl(180 85% 55%); }
  67% { color: hsl(240 85% 55%); }
  83% { color: hsl(300 85% 55%); }
  100% { color: hsl(360 85% 55%); }
}

.dir {
  position: absolute;
  left: 0;
  bottom: 8px;
  width: 100%;
  transform: scaleX(var(--pet-direction));
  transform-origin: center bottom;
}

.sprite {
  display: grid;
  grid-template-columns: 100%;
  justify-items: center;
  width: 100%;
  transform-origin: center bottom;
}

.head-row {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  min-width: 44px;
  min-height: 28px;
  white-space: nowrap;
  cursor: grab;
  touch-action: none;
  transform: scale(var(--pet-scale, 1));
  transform-origin: center;

  &:focus-visible {
    outline: 2px solid var(--pet-color);
    outline-offset: 3px;
  }

  &:hover {
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='23' viewBox='0 0 26 30'%3E%3Cpath d='M10 3a2 2 0 0 1 2 2v9l3-1a2 2 0 0 1 2 4l-5 2H8l-3-3v-6a2 2 0 0 1 2-2h1V5a2 2 0 0 1 2-2z' fill='%23f6b73c' stroke='%233b2b12' stroke-width='1.7' stroke-linejoin='round'/%3E%3C/svg%3E") 6 3, pointer;
  }
}

.face,
.hand {
  display: inline-grid;
  place-items: center;
  line-height: 1;
}

.face {
  min-width: 26px;
  padding: 0 2px;
  color: var(--pet-accent);
  .glyph-font();
  font-size: 19px;
  font-weight: 800;
  text-shadow: 0 2px 5px rgba(0, 0, 0, 0.16);
  transform-origin: center;
}

.face-flip {
  display: inline-grid;
  place-items: center;
  transform: scaleX(var(--pet-direction));
}

.face-rotate {
  position: relative;
  display: inline-grid;
  place-items: center;
  transform-style: preserve-3d;
  transform: rotateY(calc((1 + var(--pet-direction)) * 90deg));
  transition: transform 420ms ease-out;
}

.face-side {
  display: inline-grid;
  place-items: center;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;

  &.front { position: relative; }

  &.back {
    position: absolute;
    inset: 0;
    transform: rotateY(180deg) scaleX(-1);
  }
}

.hand {
  width: 14px;
  min-height: 20px;
  color: var(--pet-accent);
  .glyph-font();
  font-size: 16px;
  font-weight: 900;
  transform-origin: top center;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.14);

  &.hand-left { justify-self: end; }
  &.hand-right { justify-self: start; }
}

.meta-row {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-top: 3px;
  transform: scaleX(var(--pet-direction));
}

.name {
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.78);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: fade(@ink, 72%);
  font-size: 8px;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
}

.meta-row.has-running .name {
  max-width: 56px;
  overflow: hidden;
}

.status-row {
  display: flex;
  gap: 3px;
  width: 44px;
  margin-bottom: 2px;
}

.stat {
  position: relative;
  flex: 1;
  height: 2px;
  border-radius: 1px;
  background: fade(@ink, 14%);
  overflow: hidden;

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 1px;
    transition: width 200ms ease;
  }

  &.emotion .fill { background: #f6b73c; }
}

.zzz {
  position: absolute;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%);
  color: fade(@ink, 60%);
  font-size: 11px;
  font-weight: 800;
  pointer-events: none;
  animation: zzz-float 2.2s ease-in-out infinite;
}

.busy-indicator {
  position: absolute;
  right: 0;
  top: 26px;
  width: 16px;
  height: 16px;
  pointer-events: none;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.18));
  animation: busy-spin 1.4s linear infinite;
  transform-origin: center center;

  .busy-ring {
    stroke: fade(@ink, 28%);
    stroke-dasharray: 3 3;
  }

  .busy-arc {
    stroke: #f6b73c;
    stroke-dasharray: 18 18;
    stroke-dashoffset: 0;
    animation: busy-arc 1.4s ease-in-out infinite;
  }
}

@keyframes busy-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes busy-arc {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: -36; }
}

@keyframes zzz-float {
  0%,
  100% {
    opacity: 0.4;
    transform: translateX(-50%) translateY(0);
  }
  50% {
    opacity: 0.9;
    transform: translateX(-50%) translateY(-4px);
  }
}

.shadow {
  position: absolute;
  left: 20px;
  bottom: 3px;
  width: 32px;
  height: 7px;
  border-radius: 50%;
  background: fade(@ink, 16%);
  filter: blur(2px);
  transform: scale(var(--pet-scale, 1));
  transform-origin: center;
  animation: shadow-breathe 1.7s ease-in-out infinite;
}

@keyframes shadow-breathe {
  0%,
  100% {
    scale: 1;
    opacity: 0.7;
  }
  50% {
    scale: 0.92;
    opacity: 0.48;
  }
}
</style>
