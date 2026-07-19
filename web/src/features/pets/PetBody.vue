<script setup lang="ts">
/**
 * PetBody：宠物身体视觉组件（纯展示 + 交互事件上传）。
 * 包含 shadow / dir / sprite / status-row / head-row（hands + face-flip 3D card + meta-row）/ zzz / busy-indicator。
 * 主pet 禁翻转：--pet-direction 锁 1（身体不镜像）+ 脸绕过 3D card 渲染单一静态 .face（无背面重叠）；子pet 保留翻转。
 * 所有 drag/hover/click handler 由父组件传入（usePetDrag）。
 */
import { computed } from 'vue'
import { motion } from 'motion-v'
import type { VariantType } from 'motion-v'
import ContextBar from '@/features/agent/ContextBar.vue'
import PetToolbar from '@/features/agent/PetToolbar.vue'
import RunningTools from '@/features/agent/RunningTools.vue'
import type { StreamState } from '@/stores'
import type { PetInstance } from './types'
import type { RunningTool } from '@/stores/agents'
import { flattenQuestionItems } from '@/stores/agents/questionBatch'

const MotionSpan = motion.span

const props = defineProps<{
  pet: PetInstance
  paused: boolean
  classes: unknown[]
  style: Record<string, string>
  faceGlyph: string
  leftHand: string
  rightHand: string
  nameChars: string[]
  sprite: { animate: VariantType; transition: VariantType['transition'] }
  face: { animate: VariantType; transition: VariantType['transition'] }
  leftHandMotion: { animate: VariantType; transition: VariantType['transition'] }
  rightHandMotion: { animate: VariantType; transition: VariantType['transition'] }
  runningTools: RunningTool[]
  isBusy: boolean
  stream?: StreamState
}>()

const questionItems = () => flattenQuestionItems(props.stream)

/** workspace 最后一层文件夹名（basename，兼容 / 与 \ 及末尾分隔符）。 */
const workspaceFolder = computed(() => {
  const ws = props.pet.workspace ?? ''
  const trimmed = ws.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed || ws
})
/** 工作区 icon：有效 🖥️ / 失效（workspaceValid===false）💢。 */
const workspaceIcon = computed(() => (props.pet.workspaceValid === false ? '💢' : '🖥️'))

const emit = defineEmits<{
  history: [pet: PetInstance]
  abort: [pet: PetInstance]
  destroy: [pet: PetInstance]
  compact: [pet: PetInstance]
  resume: [pet: PetInstance]
  pointerDown: [event: PointerEvent]
  pointerMove: [event: PointerEvent]
  endPointer: [event: PointerEvent]
  headRowEnter: []
  headRowLeave: [event: PointerEvent]
  clickPet: [pet: PetInstance]
}>()
</script>

<template>
  <div class="pet" :class="classes" :style="style">
    <span class="shadow" />
    <span class="dir">
      <MotionSpan
        class="sprite"
        :initial="false"
        :animate="sprite.animate"
        :transition="sprite.transition"
      >
        <div
          v-if="!pet.isGhost"
          class="status-stack"
          :aria-label="`emotion ${Math.round(pet.emotion)}, context ${Math.round(pet.contextUsage * 100)}%`"
        >
          <div class="status-row">
            <span class="stat emotion"
              ><span class="fill" :style="{ width: `${pet.emotion}%` }"
            /></span>
            <ContextBar :usage="pet.contextUsage" :breakdown="pet.contextBreakdown" />
          </div>
          <!-- busy-indicator：思考中三点脉冲；显隐走 isBusy（与气泡显示 hasStream 解耦）。 -->
          <span v-if="isBusy" class="busy-indicator" aria-label="思考中">
            <span class="thinking-dot" />
            <span class="thinking-dot" />
            <span class="thinking-dot" />
          </span>
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
            >{{ leftHand }}</MotionSpan
          >
          <MotionSpan
            v-if="pet.isMaster"
            class="face"
            :initial="false"
            :animate="face.animate"
            :transition="face.transition"
            >{{ faceGlyph }}</MotionSpan
          >
          <span v-else class="face-flip">
            <span class="face-rotate">
              <span class="face-side front">
                <MotionSpan
                  class="face"
                  :initial="false"
                  :animate="face.animate"
                  :transition="face.transition"
                  >{{ faceGlyph }}</MotionSpan
                >
              </span>
              <span class="face-side back">
                <MotionSpan
                  class="face"
                  :initial="false"
                  :animate="face.animate"
                  :transition="face.transition"
                  >{{ faceGlyph }}</MotionSpan
                >
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
            >{{ rightHand }}</MotionSpan
          >
        </span>
        <div class="meta-row">
          <span class="name">
            <span
              v-if="pet.isMaster && pet.workspace"
              class="workspace-icon"
              :class="{ 'is-invalid': pet.workspaceValid === false }"
              :aria-label="`工作区 ${workspaceFolder}`"
            >
              {{ workspaceIcon }}
              <span class="ws-bubble">{{ workspaceFolder }}</span>
            </span>
            <span v-for="(ch, i) in nameChars" :key="i" class="char" :style="{ '--char-i': i }">{{
              ch
            }}</span>
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
        </div>
        <!-- RunningTools 独占第二行（absolute 不占高度）：提问 ❓ hover 显问题 + click 开卡片，非提问纯展示 -->
        <div
          v-if="!pet.isGhost && (runningTools.length > 0 || questionItems().length > 0)"
          class="running-row"
        >
          <RunningTools :tools="runningTools" :questions="questionItems()" :chat-id="pet.chatId" />
        </div>
      </MotionSpan>
    </span>
    <span v-if="pet.action === 'sleep'" class="zzz" aria-hidden="true">{{
      pet.sleep?.zzz ?? 'zZ'
    }}</span>
    <span v-if="pet.action === 'sleep'" class="zzz" aria-hidden="true">{{
      pet.sleep?.zzz ?? 'zZ'
    }}</span>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;
@glyph-fonts: ui-rounded, 'Hiragino Sans', 'PingFang SC', 'Noto Sans Symbols 2',
  'Noto Sans Symbols', 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;
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
  0% {
    color: hsl(0 85% 55%);
  }
  17% {
    color: hsl(60 85% 55%);
  }
  33% {
    color: hsl(120 85% 55%);
  }
  50% {
    color: hsl(180 85% 55%);
  }
  67% {
    color: hsl(240 85% 55%);
  }
  83% {
    color: hsl(300 85% 55%);
  }
  100% {
    color: hsl(360 85% 55%);
  }
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
    cursor:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='23' viewBox='0 0 26 30'%3E%3Cpath d='M10 3a2 2 0 0 1 2 2v9l3-1a2 2 0 0 1 2 4l-5 2H8l-3-3v-6a2 2 0 0 1 2-2h1V5a2 2 0 0 1 2-2z' fill='%23f6b73c' stroke='%233b2b12' stroke-width='1.7' stroke-linejoin='round'/%3E%3C/svg%3E")
        6 3,
      pointer;
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
  font-weight: 400;
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

  &.front {
    position: relative;
  }

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
  font-weight: 400;
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

/* RunningTools 行：absolute 脱离流（零布局高度），避免加行把 pet 脸顶上去与气泡错位。
   锚定 .dir（positioned 祖先）底部正下方（top:100% = meta-row 下方），水平居中。
   pet 位置/脸位/气泡对齐不再随 0/1/N 个工具变动。 */
.running-row {
  position: absolute;
  left: 50%;
  top: 100%;
  display: flex;
  justify-content: center;
  transform: translateX(-50%) scaleX(var(--pet-direction));
}

.name {
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.78);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.72);
  color: fade(@ink, 72%);
  font-size: 8px;
  font-weight: 400;
  line-height: 1.2;
  white-space: nowrap;
}

/* 工作区 icon：meta-row name 前，pet 带 workspace 时显。hover 弹 basename（最后一层文件夹名）。
   呼应 AgentDialog 工作区提示（📁/⚠），icon 改 🖥️/💢 以区分桌面端工作区语义。 */
.workspace-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-right: 2px;
  font-size: 10px;
  line-height: 1;
  vertical-align: middle;
  cursor: default;
  user-select: none;

  &:hover .ws-bubble {
    display: block;
  }
}

.ws-bubble {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  z-index: 20;
  box-sizing: border-box;
  width: max-content;
  max-width: 160px;
  margin-bottom: 4px;
  padding: 3px 6px;
  border-radius: 5px;
  background: #fff;
  border: 1px solid rgba(36, 38, 45, 0.16);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
  color: fade(@ink, 84%);
  font-size: 9px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
  text-align: center;
  /* meta-row 有 scaleX(direction)；bubble 反向 scaleX 抵消，避免 pet 朝左时文字镜像 */
  transform: translateX(-50%) scaleX(var(--pet-direction));
}

.status-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin-bottom: 2px; /* 原 .status-row 的 margin-bottom */
}

.status-row {
  display: flex;
  gap: 3px;
  width: 44px;
  position: relative;
  top: -4px; /* 上移避免与 .busy-indicator 绝对定位重叠 */
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
  font-weight: 600;
  pointer-events: none;
  animation: zzz-float 2.2s ease-in-out infinite;
}

.busy-indicator {
  /* 改为 .status-stack 的 flex 子项，与 .status-row 上下堆叠 */
  display: inline-flex;
  position: absolute;
  right: 0;
  align-items: center;
  gap: 2px;
  padding: 2px 5px;
  border: 1px dashed rgba(124, 58, 237, 0.55); /* 思考紫虚线，呼应 PetBubbles.is-thinking */
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.9);
  pointer-events: none;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.18));
  transform-origin: center center;

  .thinking-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #7c3aed; /* 思考紫 */
    animation: thinking-dot 1.2s ease-in-out infinite;

    &:nth-child(2) {
      animation-delay: 0.18s;
    }
    &:nth-child(3) {
      animation-delay: 0.36s;
    }
  }
}

@keyframes thinking-dot {
  0%,
  60%,
  100% {
    opacity: 0.28;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
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
