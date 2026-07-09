<script setup lang="ts">
import { AnimatePresence, motion } from "motion-v";
import { computed } from "vue";
import ApprovalCard from "@/features/agent/ApprovalCard.vue";
import ContextBar from "@/features/agent/ContextBar.vue";
import PetToolbar from "@/features/agent/PetToolbar.vue";
import type { StreamState } from "@/stores";
import { faceMotion, ghostFaceMotion, ghostSpriteMotion, handMotion, speechMotion, spriteMotion } from "./petMotion";
import { usePetDrag } from "./usePetDrag";
import { useStreamBubble } from "./useStreamBubble";
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
  /** chat 流式状态（PetStage 注入 agents.streams[pet.chatId]）。undefined / isWorking=false → 不显工作气泡。 */
  stream?: StreamState;
  /** ghost 首领可拖标记（PetStage 算 leaderIds 传入）。true 时放行 ghost 长按拖拽；非首领 ghost 仍仅 click→history。 */
  ghostDraggable?: boolean;
}>();

const emit = defineEmits<{
  startDrag: [pet: PetInstance, event: PointerEvent];
  drag: [pet: PetInstance, event: PointerEvent];
  endDrag: [pet: PetInstance, event: PointerEvent];
  hover: [pet: PetInstance, hovering: boolean];
  clickPet: [pet: PetInstance];
  history: [pet: PetInstance];
  abort: [pet: PetInstance];
  destroy: [pet: PetInstance];
  compact: [pet: PetInstance];
}>();

// 拖拽 + 身体 hover 状态机（长按拖/短按抚摸 + petHover）下沉 usePetDrag；
// petHover 供 z-index 提层 + 工作气泡 retain（useStreamBubble 收为 isHovered）。
const {
  petHover,
  onPetEnter,
  onPointerDown,
  onPointerMove,
  endPointer,
  onPointerLeave,
  onHeadRowEnter,
  onHeadRowLeave,
  onClick,
} = usePetDrag(props, emit);

// 工作气泡显隐/保留/滚动下沉 useStreamBubble（retain 定时器 + auto-scroll watcher 自管）。
const {
  hasStream,
  showWorkMain,
  showWorkSide,
  thinkingOnly,
  hasContent,
  displayThinking,
  displayContent,
  renderedContent,
  workTextRef,
  onWorkTextScroll,
  onBubbleEnter,
  onBubbleLeave,
} = useStreamBubble(props, petHover);

const faceGlyph = computed(() => (props.pet.isGhost ? props.pet.ghostFace ?? "👻" : props.pet.face[props.pet.mood]));
const leftHand = computed(() => props.pet.hands[props.pet.mood].left);
const rightHand = computed(() => props.pet.hands[props.pet.mood].right);
// name 拆字符：主 pet per-char 彩虹流动（色相递增 + delay 错相，从左往右波浪）
const nameChars = computed(() => Array.from(props.pet.name));

const sprite = computed(() => (props.pet.isGhost ? ghostSpriteMotion() : spriteMotion(props.pet.action)));
const face = computed(() => (props.pet.isGhost ? ghostFaceMotion() : faceMotion(props.pet.mood)));
const leftHandMotion = computed(() => handMotion(props.pet.action, "left"));
const rightHandMotion = computed(() => handMotion(props.pet.action, "right"));
const speech = speechMotion();

// thinking 侧气泡 motion：与 speechMotion 同构（opacity+scale 进退），顶部齐平主气泡
// （x:"-100%" 向左展开，y:"-100%" 底部对齐锚点上移自身高度，与主气泡顶部齐平）。
const workSideMotion = {
  initial: { opacity: 0, scale: 0.86, x: "-100%", y: "-100%" },
  animate: { opacity: 1, scale: 1, x: "-100%", y: "-100%" },
  exit: { opacity: 0, scale: 0.86, x: "-100%", y: "-100%" },
  transition: { duration: 0.18, ease: "easeOut" as const },
};

// 气泡锚点：气泡底部贴 status-row（emotion+context bar）上方 16px。
// status-row 顶 ≈ pet.y+44（.dir bottom:8px + sprite 内容高，估算），故 offset=28（44-16）。视觉不准微调此常量。
const BUBBLE_OFFSET_Y = 28;

/**
 * pet 身体 z-index：拖拽最高；否则 hasSpeech 加成（子有气泡主无时子>主，主子都有时主>子）。
 * 气泡独立 z-index（speechZIndex）整体高于身体——因 .pet-wrap 不创建 stacking context
 * （无 z-index/position），.speech 与 .pet 的 z-index 在 stage 层级跨 pet 直接比较。
 */
function petBodyZIndex(pet: PetInstance, hovered: boolean): number {
  if (pet.action === "dragging") return 20;
  if (hovered) return 15; // hover 提层级（低于 drag 20、高于普通 pet）-> 被悬停 pet 置顶，ghost 队列残余对角重叠时不被遮挡
  return (pet.speech ? 10 : 0) + (pet.isMaster ? 2 : 1);
}
function speechZIndex(pet: PetInstance): number {
  if (pet.action === "dragging") return 120;
  return 100 + (pet.isMaster ? 2 : 1);
}

const style = computed(() => ({
  transform: `translate3d(${props.pet.x}px, ${props.pet.y}px, 0)`,
  zIndex: String(petBodyZIndex(props.pet, petHover.value)),
  "--pet-color": props.pet.color,
  "--pet-accent": props.pet.accent,
  "--pet-direction": String(props.pet.direction),
  "--pet-scale": props.pet.isGhost ? "0.7" : props.pet.isMaster ? "1" : "0.75",
  "--tribe-hue": `${hashHue(props.pet.tribe)}deg`,
}));

// 气泡锚点下移 BUBBLE_OFFSET_Y：底部贴 status-row 上方 10px（非 pet 容器顶）。
// motion x:"-50%" y:"-100%" 水平居中 + 上移自身高度（底部对齐锚点）。
const speechStyle = computed(() => ({
  left: `${props.pet.x + props.pet.width / 2}px`,
  top: `${props.pet.y + BUBBLE_OFFSET_Y}px`,
  zIndex: String(speechZIndex(props.pet)),
}));

// thinking 侧气泡：主气泡左侧，顶部齐平（top 同主气泡），motion x:"-100%" y:"-100%" 右对齐向左展开。
// left=pet.x-60：侧气泡右边在主气泡左边左侧（主气泡中心 pet.x+36，半宽≤90 → 左边≥pet.x-54）。
const sideBubbleStyle = computed(() => ({
  left: `${props.pet.x - 60}px`,
  top: `${props.pet.y + BUBBLE_OFFSET_Y}px`,
  zIndex: String(speechZIndex(props.pet)),
}));

const classes = computed(() => [
  `is-${props.pet.action}`,
  `mood-${props.pet.mood}`,
  {
    "is-master": props.pet.isMaster,
    "is-sub": !props.pet.isMaster,
    "is-ghost": props.pet.isGhost,
    "is-paused": props.paused,
  },
]);

</script>

<template>
  <div class="pet-wrap">
    <AnimatePresence>
      <MotionDiv
        v-if="stream?.approval"
        key="approval"
        class="speech approval-bubble"
        :style="speechStyle"
        :initial="speech.initial"
        :animate="speech.animate"
        :exit="speech.exit"
        :transition="speech.transition"
      >
        <ApprovalCard :approval="stream!.approval!" :chat-id="pet.chatId" />
      </MotionDiv>
      <MotionDiv
        v-else-if="showWorkMain"
        key="work-main"
        class="speech work-bubble"
        :class="{ 'is-thinking': thinkingOnly }"
        :style="speechStyle"
        :initial="speech.initial"
        :animate="speech.animate"
        :exit="speech.exit"
        :transition="speech.transition"
        @pointerenter="onBubbleEnter"
        @pointerleave="onBubbleLeave"
      >
        <div ref="workTextRef" class="work-text" :class="{ 'is-thinking': thinkingOnly }" @scroll="onWorkTextScroll">
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义，XSS 安全 -->
          <span v-if="hasContent" class="md" v-html="renderedContent" />
          <template v-else>{{ displayThinking }}</template>
        </div>
      </MotionDiv>
      <MotionDiv
        v-else-if="pet.speech || $slots.dialog"
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
    <AnimatePresence>
      <MotionDiv
        v-if="showWorkSide"
        key="work-side"
        class="speech work-bubble side is-thinking"
        :style="sideBubbleStyle"
        :initial="workSideMotion.initial"
        :animate="workSideMotion.animate"
        :exit="workSideMotion.exit"
        :transition="workSideMotion.transition"
        @pointerenter="onBubbleEnter"
        @pointerleave="onBubbleLeave"
      >
        <div class="work-text is-thinking">{{ displayThinking }}</div>
      </MotionDiv>
    </AnimatePresence>
    <div
      class="pet"
      :class="classes"
      :style="style"
      @pointerenter="onPetEnter"
      @pointerleave="onPointerLeave"
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
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="endPointer"
          @pointercancel="endPointer"
          @pointerenter="onHeadRowEnter"
          @pointerleave="onHeadRowLeave"
          @click.stop="onClick"
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
          <MotionSpan
            class="face"
            :initial="false"
            :animate="face.animate"
            :transition="face.transition"
          >{{ faceGlyph }}</MotionSpan>
          <MotionSpan
            v-if="!pet.isGhost"
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
          <PetToolbar
            v-if="!pet.isGhost"
            :pet="pet"
            @history="emit('history', pet)"
            @abort="emit('abort', pet)"
            @destroy="emit('destroy', pet)"
            @compact="emit('compact', pet)"
          />
        </div>
      </MotionSpan>
    </span>
      <span v-if="pet.action === 'sleep'" class="zzz" aria-hidden="true">{{ pet.sleep?.zzz ?? "zZ" }}</span>
      <span v-if="hasStream && !pet.isGhost" class="busy-indicator" aria-hidden="true">⚙</span>
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

  &.is-ghost {
    opacity: 0.75;
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.5)) drop-shadow(0 0 8px rgba(255, 255, 255, 0.6));
    // 72×96 框不捕获 pointer（消队列内 .pet 互相重叠遮挡 -> 原 hover/click 命中错误 ghost、leader 拖不动）；
    // hover/click/drag 收窄到下方 .head-row（emoji 命中区）
    pointer-events: none;

    .head-row {
      cursor: pointer;
      pointer-events: auto; // 仅 emoji 命中区承接交互
      min-width: 0; // 收缩到 .face（emoji ~26px），原 min 44×28 远大于 emoji
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
  /* 子 pet 体型缩小（--pet-scale）；工具栏/状态条/名字不缩 */
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

.tools,
.tool-icon {
  /* 已移除：PetToolbar 组件取代（按钮组 + tip 由 PetToolbar scoped 样式提供） */
  display: none;
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

/* Req 6: 忙碌指示器 — 面部右上角旋转 ⚙ */
.busy-indicator {
  position: absolute;
  right: 2px;
  top: 28px;
  font-size: 10px;
  color: fade(@ink, 50%);
  pointer-events: none;
  animation: busy-spin 2s linear infinite;
}

@keyframes busy-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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

/* 工作气泡：thinking/content 流式显示。继承 .speech 基础定位 + 覆写尺寸/滚动。
   主气泡全空间（content 阶段）或全空间显 thinking（thinking-only 阶段）。
   侧气泡（thinking 副本）略小，定位由 sideBubbleStyle + motion x:"-100%" y:"-50%"。 */
.work-bubble {
  max-width: 180px;
  max-height: 140px;
  padding: 5px 0 5px 8px; /* 去除右 padding，滚动条贴右侧外框 */
  font-size: 10px;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  /* Req 1: thinking-only 阶段视觉区分 — 浅灰背景 + 虚线边框 */
  &.is-thinking {
    background: rgba(240, 238, 245, 0.92);
    border-color: rgba(140, 130, 170, 0.4);
    border-style: dashed;
  }

  &.side {
    // 侧气泡=thinking 副本：复用 &.is-thinking 浅灰虚线背景/边框 + work-text.is-thinking 斜体灰字，
    // 与主气泡 content（白底实线）区分。删 opacity/白色覆盖以让 is-thinking 生效；尺寸同主气泡（顶部齐平）。
    max-width: 180px;
    max-height: 140px;
    padding: 5px 0 5px 8px;
    font-size: 10px;
  }

  .work-text {
    flex: 1;
    overflow: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    padding-right: 8px; /* 文本与贴边滚动条间距 */
    /* 滚动条贴右侧：外框无右 padding，滚动条自然贴 border 内缘 */
    scrollbar-width: thin;
    scrollbar-color: rgba(20, 22, 26, 0.25) transparent;

    &::-webkit-scrollbar {
      width: 4px;
    }

    &::-webkit-scrollbar-track {
      background: transparent;
    }

    &::-webkit-scrollbar-thumb {
      background: rgba(20, 22, 26, 0.25);
      border-radius: 2px;

      &:hover {
        background: rgba(20, 22, 26, 0.4);
      }
    }

    &.is-thinking {
      color: fade(@ink, 64%);
      font-style: italic;
    }

    // content markdown 渲染（复用 renderMarkdown）；thinking 保持纯文本 pre-wrap
    .md {
      white-space: normal;

      :deep(p) {
        margin: 0 0 4px;
        &:last-child { margin: 0; }
      }
      :deep(h1), :deep(h2), :deep(h3), :deep(h4) {
        font-size: 11px;
        font-weight: 800;
        margin: 4px 0 2px;
        line-height: 1.3;
      }
      :deep(ul), :deep(ol) {
        margin: 4px 0;
        padding-left: 16px;
      }
      :deep(li) { margin: 1px 0; }
      :deep(code) {
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        font-size: 9px;
        padding: 0 3px;
        border-radius: 2px;
        background: rgba(20, 22, 26, 0.06);
      }
      :deep(pre) {
        margin: 4px 0;
        overflow-x: auto;
      }
      :deep(pre code) {
        padding: 0;
        background: transparent;
      }
      :deep(blockquote) {
        margin: 3px 0;
        padding: 0 6px;
        border-left: 2px solid rgba(246, 183, 60, 0.5);
        color: fade(@ink, 60%);
      }
      :deep(a) {
        color: #b8860b;
        text-decoration: underline;
      }
    }
  }
}

/* 审批气泡：interrupt 触发时显 ApprovalCard。继承 .speech 基础 + 覆写尺寸/边色（橙色提示需处理）。 */
.approval-bubble {
  max-width: 220px;
  padding: 5px 8px;
  background: rgba(255, 248, 235, 0.96);
  border-color: rgba(234, 88, 12, 0.42);
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