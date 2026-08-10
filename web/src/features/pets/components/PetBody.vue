<script setup lang="ts">
/**
 * PetBody：宠物身体视觉组件（纯展示 + 交互事件上传）。
 * 骨架：shadow / dir / sprite / head-row（hands + face：master 单 face / sub 委托 PetFaceFlip）/ meta-row（PetNameTag + PetToolbar）/ running-row / zzz。
 * 状态条（emotion/context/busy）委托 PetStatusBar；3D 翻转脸卡委托 PetFaceFlip；名字/工作区委托 PetNameTag。
 * 主pet 禁翻转：--pet-direction 锁 1（身体不镜像）+ 脸绕过 3D card 渲染单一静态 .face（无背面重叠）；子pet 保留翻转。
 * 所有 drag/hover/click handler 由父组件传入（usePetDrag）。
 */
import { computed } from 'vue'
import { motion } from 'motion-v'
import type { VariantType } from 'motion-v'
import PetToolbar from '@/features/agent/toolbar/PetToolbar.vue'
import RunningTools from '@/features/agent/cards/RunningTools.vue'
import type { StreamState } from '@/stores'
import type { PetInstance } from '../types/types'
import type { RunningTool } from '@/stores/agents'
import { flattenQuestionItems } from '@/stores/agents/actions/questionBatch'
import PetStatusBar from './PetStatusBar.vue'
import PetFaceFlip from './PetFaceFlip.vue'
import PetNameTag from './PetNameTag.vue'

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
  doubleClickPet: [pet: PetInstance]
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
        <PetStatusBar
          v-if="!pet.isGhost"
          :emotion="pet.emotion"
          :context-usage="pet.contextUsage"
          :context-breakdown="pet.contextBreakdown"
          :is-busy="isBusy"
        />
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
          @dblclick.stop="emit('doubleClickPet', pet)"
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
          <PetFaceFlip v-else :face-glyph="faceGlyph" :face-motion="face" />
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
          <PetNameTag
            :name-chars="nameChars"
            :is-master="pet.isMaster"
            :is-sub="!pet.isMaster"
            :workspace="pet.workspace"
            :workspace-valid="pet.workspaceValid"
            :workspace-folder="workspaceFolder"
            :workspace-icon="workspaceIcon"
          />
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
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);
@glyph-fonts: ui-rounded, 'Hiragino Sans', 'PingFang SC', 'Noto Sans Symbols 2',
  'Noto Sans Symbols', 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;

.glyph-font() {
  font-family: @glyph-fonts;
}

.pet {
  --pet-color: #f6b73c;
  --pet-accent: var(--ink);
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

.zzz {
  position: absolute;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%);
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  font-size: 11px;
  font-weight: 600;
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
  background: color-mix(in srgb, var(--ink) 16%, transparent);
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
