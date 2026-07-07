<script setup lang="ts">
import { AnimatePresence, motion } from "motion-v";
import { computed, onBeforeUnmount, ref } from "vue";
import { faceMotion, handMotion, speechMotion, spriteMotion } from "./petMotion";
import type { PetInstance } from "./types";

const MotionSpan = motion.span;
const MotionDiv = motion.div;

// tribe → 色相：子 pet name 部落色区分（主 pet name 保持 --pet-color 高亮）
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

const props = defineProps<{
  pet: PetInstance;
  paused: boolean;
}>();

const emit = defineEmits<{
  startDrag: [pet: PetInstance, event: PointerEvent];
  drag: [pet: PetInstance, event: PointerEvent];
  endDrag: [pet: PetInstance, event: PointerEvent];
  hover: [pet: PetInstance, hovering: boolean];
  clickPet: [pet: PetInstance];
  tool: [pet: PetInstance, toolId: string];
}>();

const faceGlyph = computed(() => props.pet.face[props.pet.mood]);
const leftHand = computed(() => props.pet.hands[props.pet.mood].left);
const rightHand = computed(() => props.pet.hands[props.pet.mood].right);
// name 拆字符：主 pet per-char 彩虹流动（色相递增 + delay 错相，从左往右波浪）
const nameChars = computed(() => Array.from(props.pet.name));

const sprite = computed(() => spriteMotion(props.pet.action));
const face = computed(() => faceMotion(props.pet.mood));
const leftHandMotion = computed(() => handMotion(props.pet.action, "left"));
const rightHandMotion = computed(() => handMotion(props.pet.action, "right"));
const speech = speechMotion();

const coreTools = computed(() => props.pet.tools.filter((t) => t.core));
const moreTools = computed(() => props.pet.tools.filter((t) => !t.core));
const moreOpen = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | undefined;

// 第二行工具：悬浮 .tools 即展开；离开后延迟关闭，便于鼠标跨行不被中断
function openTools(): void {
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
  moreOpen.value = true;
}

function scheduleCloseTools(): void {
  if (closeTimer !== undefined) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    moreOpen.value = false;
    closeTimer = undefined;
  }, 240);
}

onBeforeUnmount(() => {
  if (closeTimer !== undefined) clearTimeout(closeTimer);
  if (longPressTimer !== undefined) clearTimeout(longPressTimer);
});

/**
 * pet 身体 z-index：拖拽最高；否则 hasSpeech 加成（子有气泡主无时子>主，主子都有时主>子）。
 * 气泡独立 z-index（speechZIndex）整体高于身体——因 .pet-wrap 不创建 stacking context
 * （无 z-index/position），.speech 与 .pet 的 z-index 在 stage 层级跨 pet 直接比较。
 */
function petBodyZIndex(pet: PetInstance): number {
  if (pet.action === "dragging") return 20;
  return (pet.speech ? 10 : 0) + (pet.isMaster ? 2 : 1);
}
function speechZIndex(pet: PetInstance): number {
  if (pet.action === "dragging") return 120;
  return 100 + (pet.isMaster ? 2 : 1);
}

const style = computed(() => ({
  transform: `translate3d(${props.pet.x}px, ${props.pet.y}px, 0)`,
  zIndex: String(petBodyZIndex(props.pet)),
  "--pet-color": props.pet.color,
  "--pet-accent": props.pet.accent,
  "--pet-direction": String(props.pet.direction),
  "--pet-scale": props.pet.isMaster ? "1" : "0.62",
  "--tribe-hue": `${hashHue(props.pet.tribe)}deg`,
}));

// 气泡定位：锚点 = pet 顶部中心（left=pet.x+width/2, top=pet.y）；
// motion x:"-50%" y:"-100%" 再将气泡水平居中、上移自身高度（底部对齐锚点，向 pet 上方展开）。
const speechStyle = computed(() => ({
  left: `${props.pet.x + props.pet.width / 2}px`,
  top: `${props.pet.y}px`,
  zIndex: String(speechZIndex(props.pet)),
}));

const classes = computed(() => [
  `is-${props.pet.action}`,
  `mood-${props.pet.mood}`,
  { "is-master": props.pet.isMaster, "is-sub": !props.pet.isMaster, "is-paused": props.paused },
]);

// 长按拖拽：pointerdown 启 300ms 定时器，超时或移动超阈值才 startDrag；
// 短按（<300ms 且未超阈值）松开 → 不拖拽，让 click 触发抚摸（clickPet）。
// 拖拽结束的 pointerup 会紧随触发 click → suppressClick 抑制，避免拖拽完又抚摸。
const LONG_PRESS_MS = 300;
const DRAG_THRESHOLD_PX = 5;
let downX = 0;
let downY = 0;
let longPressTimer: ReturnType<typeof setTimeout> | undefined;
let draggingStarted = false;
let suppressClick = false;

function beginDrag(target: HTMLElement, event: PointerEvent): void {
  draggingStarted = true;
  target.setPointerCapture(event.pointerId);
  emit("startDrag", props.pet, event);
}

function onPointerDown(event: PointerEvent): void {
  downX = event.clientX;
  downY = event.clientY;
  draggingStarted = false;
  const target = event.currentTarget as HTMLElement;
  longPressTimer = setTimeout(() => {
    longPressTimer = undefined;
    beginDrag(target, event);
  }, LONG_PRESS_MS);
}

function onPointerMove(event: PointerEvent): void {
  if (longPressTimer !== undefined) {
    // 长按等待中：移动超阈值 → 立即进拖拽（同长按超时路径）
    const dx = event.clientX - downX;
    const dy = event.clientY - downY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
      const target = event.currentTarget as HTMLElement;
      beginDrag(target, event);
      emit("drag", props.pet, event);
    }
    return;
  }
  if (draggingStarted) {
    emit("drag", props.pet, event);
  }
}

// pointerup / pointercancel 共用：短按取消定时器；拖拽中收尾 endDrag。
function endPointer(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement;
  if (longPressTimer !== undefined) {
    clearTimeout(longPressTimer);
    longPressTimer = undefined;
    draggingStarted = false;
    return;
  }
  if (draggingStarted) {
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    emit("endDrag", props.pet, event);
    draggingStarted = false;
    suppressClick = true;
  }
}

function onPointerLeave(event: PointerEvent): void {
  // 长按等待中离开元素：取消定时器，避免离开后异步 startDrag 无人响应
  if (longPressTimer !== undefined) {
    clearTimeout(longPressTimer);
    longPressTimer = undefined;
    draggingStarted = false;
  }
  emit("hover", props.pet, false);
}

function onClick(): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  emit("clickPet", props.pet);
}
</script>

<template>
  <div class="pet-wrap">
    <AnimatePresence>
      <MotionDiv
        v-if="pet.speech || $slots.dialog"
        :key="pet.speechUntil"
        class="speech"
        :style="speechStyle"
        :initial="speech.initial"
        :animate="speech.animate"
        :exit="speech.exit"
        :transition="speech.transition"
      >
        <slot name="dialog" :pet="pet">{{ pet.speech }}</slot>
      </MotionDiv>
    </AnimatePresence>
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
        <div class="status-row" :aria-label="`emotion ${Math.round(pet.emotion)}, fatigue ${Math.round(pet.fatigue)}`">
          <span class="stat emotion"><span class="fill" :style="{ width: `${pet.emotion}%` }" /></span>
          <span class="stat fatigue"><span class="fill" :style="{ width: `${pet.fatigue}%` }" /></span>
        </div>
        <span
          class="head-row"
          role="button"
          tabindex="0"
          :aria-label="`${pet.name} pet`"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="endPointer"
          @pointercancel="endPointer"
          @pointerenter="emit('hover', pet, true)"
          @pointerleave="onPointerLeave"
          @click.stop="onClick"
          @keydown.enter.space.prevent="emit('clickPet', pet)"
        >
          <MotionSpan
            class="hand hand-left"
            aria-hidden="true"
            :initial="false"
            :animate="leftHandMotion.animate"
            :transition="leftHandMotion.transition"
          >{{ leftHand }}</MotionSpan>
          <MotionSpan
            class="face"
            :initial="false"
            :animate="face.animate"
            :transition="face.transition"
          >{{ faceGlyph }}</MotionSpan>
          <MotionSpan
            class="hand hand-right"
            aria-hidden="true"
            :initial="false"
            :animate="rightHandMotion.animate"
            :transition="rightHandMotion.transition"
          >{{ rightHand }}</MotionSpan>
        </span>
        <div class="meta-row">
          <span class="name">
            <span
              v-for="(ch, i) in nameChars"
              :key="i"
              class="char"
              :style="{ '--char-i': i }"
            >{{ ch }}</span>
          </span>
          <div
            class="tools"
            :class="{ 'more-open': moreOpen }"
            @pointerenter="openTools"
            @pointerleave="scheduleCloseTools"
          >
            <button
              v-for="t in coreTools"
              :key="t.id"
              type="button"
              class="tool-icon"
              :aria-label="t.label"
              @pointerdown.stop
              @click.stop="emit('tool', pet, t.id)"
            >
              {{ t.icon }}<span class="tip">{{ t.label }}</span>
            </button>
            <div v-if="moreTools.length" class="tools-extra">
              <button
                v-for="t in moreTools"
                :key="t.id"
                type="button"
                class="tool-icon"
                :aria-label="t.label"
                @pointerdown.stop
                @click.stop="emit('tool', pet, t.id)"
              >
                {{ t.icon }}<span class="tip">{{ t.label }}</span>
              </button>
            </div>
          </div>
        </div>
      </MotionSpan>
    </span>
      <span v-if="pet.action === 'sleep'" class="zzz" aria-hidden="true">{{ pet.sleep?.zzz ?? "zZ" }}</span>
    </div>
  </div>
</template>

<style scoped lang="less">
// ink 基色 = rgb(20,22,26)，各 alpha 由 fade() 派生（取代散落的 rgba(20,22,26,…) 字面量）
@ink: #14161a;
@glyph-fonts: ui-rounded, "Hiragino Sans", "PingFang SC", "Noto Sans Symbols 2",
  "Noto Sans Symbols", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif;
// tribe 派生色含 CSS 变量（运行期），仅抽字符串消除重复，less 不参与计算
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
  z-index: 1; /* fallback；实际由 inline style 动态覆盖（petBodyZIndex：dragging20 / hasSpeech+主子）*/
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
    /* z-index 由 inline 覆盖（dragging=20） */
    filter: drop-shadow(0 12px 18px rgba(0, 0, 0, 0.24));

    .head-row {
      cursor: grabbing;
    }
  }

  &.is-master .name {
    border-color: @tribe-border;
    background: @tribe-bg;

    .char {
      color: hsl(0 85% 55%);
      animation: rainbow-char 3s linear infinite;
      /* 字符序 delay 错相：色相波从左往右流动；某时刻各字符色相不同 */
      animation-delay: calc(var(--char-i, 0) * 0.2s);
    }
  }

  &.is-sub .name {
    border-color: @tribe-border;
    background: @tribe-bg;
    color: @tribe-ink;
  }

  &.is-paused {
    opacity: 0.78;
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
  /* 子 pet 体型缩小（--pet-scale）；工具栏/状态条/名字不缩 */
  transform: scale(var(--pet-scale, 1));
  transform-origin: center;

  &:focus-visible {
    outline: 2px solid var(--pet-color);
    outline-offset: 3px;
  }

  &:hover {
    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='30' viewBox='0 0 26 30'%3E%3Cpath d='M10 3a2 2 0 0 1 2 2v9l3-1a2 2 0 0 1 2 4l-5 2H8l-3-3v-6a2 2 0 0 1 2-2h1V5a2 2 0 0 1 2-2z' fill='%23f6b73c' stroke='%233b2b12' stroke-width='1.3' stroke-linejoin='round'/%3E%3C/svg%3E") 8 4, pointer;
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

.hand {
  width: 14px;
  min-height: 20px;
  color: var(--pet-accent);
  .glyph-font();
  font-size: 16px;
  font-weight: 900;
  transform-origin: top center;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.14);

  &.hand-left {
    justify-self: end;
  }

  &.hand-right {
    justify-self: start;
  }
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

.tools {
  display: inline-flex;
  align-items: center;
  gap: 2px;

  .tools-extra {
    position: absolute;
    top: calc(100% + 4px);
    left: 50%;
    z-index: 5;
    display: flex;
    gap: 2px;
    padding: 3px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.94);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.12);
    opacity: 0;
    transform: translateX(-50%) translateY(-2px);
    pointer-events: none;
    transition: opacity 160ms ease, transform 160ms ease;
  }

  &.more-open .tools-extra {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
    pointer-events: auto;
  }
}

.tool-icon {
  position: relative;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.82);
  color: #24262d;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  overflow: visible;

  &:hover {
    background: #ffffff;
  }

  .tip {
    position: absolute;
    bottom: 130%;
    left: 50%;
    transform: translateX(-50%) scale(0.9);
    padding: 2px 6px;
    border-radius: 5px;
    background: fade(@ink, 90%);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease, transform 120ms ease;
  }

  &:hover .tip {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
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

  &.emotion .fill {
    background: #f6b73c;
  }

  &.fatigue .fill {
    background: #6b7280;
  }
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
  /* 随子 pet 体型缩小（与 shadow-breathe 的 scale 属性复合） */
  transform: scale(var(--pet-scale, 1));
  transform-origin: center;
  animation: shadow-breathe 1.7s ease-in-out infinite;
}

.speech {
  position: absolute;
  /* left/top 由 inline speechStyle 提供（锚点 = pet 顶部中心）；
     motion x:"-50%" y:"-100%" 水平居中 + 上移自身高度（底部对齐锚点，向 pet 上方展开）。
     .pet-wrap 不创建 stacking context，故 z-index 在 stage 层级跨 pet 比较。*/
  min-width: 28px;
  max-width: 96px;
  padding: 4px 7px;
  border: 1px solid rgba(255, 255, 255, 0.74);
  border-radius: 7px;
  color: #23242a;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.16);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.2;
  overflow-wrap: anywhere;
  transform-origin: center bottom;

  &::after {
    content: "";
    position: absolute;
    left: 14px;
    bottom: -5px;
    width: 8px;
    height: 8px;
    border-right: 1px solid rgba(255, 255, 255, 0.74);
    border-bottom: 1px solid rgba(255, 255, 255, 0.74);
    background: rgba(255, 255, 255, 0.92);
    transform: rotate(45deg);
  }
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
