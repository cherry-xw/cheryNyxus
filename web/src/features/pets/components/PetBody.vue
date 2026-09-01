<script setup lang="ts">
/**
 * PetBody：宠物身体视觉组件（纯展示 + 交互事件上传）。
 * 骨架：shadow / dir / sprite / head-row（hands + face：master 单 face / sub 委托 PetFaceFlip）/ meta-row（PetNameTag + PetToolbar）/ running-row / zzz。
 * 状态条（emotion/context/busy）委托 PetStatusBar；3D 翻转脸卡委托 PetFaceFlip；名字/工作区委托 PetNameTag。
 * 主pet 禁翻转：--pet-direction 锁 1（身体不镜像）+ 脸绕过 3D card 渲染单一静态 .face（无背面重叠）；子pet 保留翻转。
 * 所有 drag/hover/click handler 由父组件传入（usePetDrag）。
 */
import { computed, ref, toRef } from 'vue'
import type { PetMotionDescriptor } from '@/domain/pets/motion/animation'
import { usePetMotion } from '../composables/usePetMotion'
import PetToolbar from '@/features/agent/toolbar/PetToolbar.vue'
import RunningTools from '@/features/agent/cards/RunningTools.vue'
import type { StreamState } from '@/application/public'
import type { PetInstance } from '@/domain/pets/types'
import type { RunningTool } from '@/domain/chat/projectionTypes'
import { flattenQuestionItems } from '@/domain/chat/questionProjection'
import PetStatusBar from './PetStatusBar.vue'
import PetDivineHalo from './PetDivineHalo.vue'
import PetFaceFlip from './PetFaceFlip.vue'
import PetNameTag from './PetNameTag.vue'

const props = defineProps<{
  pet: PetInstance
  paused: boolean
  classes: unknown[]
  style: Record<string, string>
  faceGlyph: string
  leftHand: string
  rightHand: string
  nameChars: string[]
  sprite: PetMotionDescriptor
  face: PetMotionDescriptor
  leftHandMotion: PetMotionDescriptor
  rightHandMotion: PetMotionDescriptor
  runningTools: RunningTool[]
  isBusy: boolean
  stream?: StreamState
  positionRef?: (element: HTMLElement | null) => void
}>()

const spriteRef = ref<HTMLElement | null>(null)
const faceRef = ref<HTMLElement | null>(null)
const leftHandRef = ref<HTMLElement | null>(null)
const rightHandRef = ref<HTMLElement | null>(null)
usePetMotion(spriteRef, toRef(props, 'sprite'))
usePetMotion(faceRef, toRef(props, 'face'))
usePetMotion(leftHandRef, toRef(props, 'leftHandMotion'))
usePetMotion(rightHandRef, toRef(props, 'rightHandMotion'))

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
  <div
    :ref="(element) => positionRef?.(element as HTMLElement | null)"
    class="pet"
    :class="classes"
    :style="style"
  >
    <span class="shadow" />
    <span class="dir">
      <span
        ref="spriteRef"
        class="sprite"
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
          <span
            v-if="!pet.isGhost"
            ref="leftHandRef"
            class="hand hand-left"
            aria-hidden="true"
            >{{ leftHand }}</span
          >
          <span v-if="pet.isMaster" class="face-shell">
            <PetDivineHalo :active="isBusy" />
            <span
              ref="faceRef"
              class="face"
              >{{ faceGlyph }}</span
            >
          </span>
          <PetFaceFlip v-else :face-glyph="faceGlyph" :face-motion="face" :active="isBusy" />
          <span
            v-if="!pet.isGhost"
            ref="rightHandRef"
            class="hand hand-right"
            aria-hidden="true"
            >{{ rightHand }}</span
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
          <!-- 运行中工具锚定在控制台底部；meta-row 自身脱离主体布局，数量变化不会推动脸部。 -->
          <div
            v-if="!pet.isGhost && (runningTools.length > 0 || questionItems().length > 0)"
            class="running-row"
          >
            <RunningTools
              :tools="runningTools"
              :questions="questionItems()"
              :chat-id="pet.chatId"
            />
          </div>
        </div>
      </span>
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
  --pet-color: var(--accent);
  --pet-accent: var(--ink);
  // 浅色主题使用深靛光晕承托浅色颜文字。
  --aura-center: rgba(55, 48, 163, 0.96);
  --aura-mid: rgba(79, 70, 229, 0.58);
  --aura-edge: rgba(34, 199, 223, 0.16);
  --aura-ray: rgba(79, 70, 229, 0.72);
  --aura-vein: #c7d2fe;
  --aura-secondary: #22c7df;
  --aura-shadow: rgba(49, 46, 129, 0.4);
  --pet-face-ink: #f7f5ff;
  --pet-face-outline: rgba(24, 18, 66, 0.9);
  --pet-face-glow: rgba(221, 223, 255, 0.28);
  --pet-console-bg: color-mix(in srgb, var(--surface) 96%, hsl(var(--tribe-hue) 70% 62%) 4%);
  --pet-console-border: color-mix(in srgb, var(--ink) 22%, hsl(var(--tribe-hue) 58% 48%) 18%);
  --pet-console-ink: color-mix(in srgb, var(--ink) 86%, hsl(var(--tribe-hue) 55% 38%) 14%);
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

// 深色主题使用冷青/靛蓝信标光，保持精密控制台语言。
[data-theme='dark'] .pet {
  --aura-center: rgba(14, 116, 144, 0.96);
  --aura-mid: rgba(34, 211, 238, 0.64);
  --aura-edge: rgba(99, 102, 241, 0.18);
  --aura-ray: rgba(103, 232, 249, 0.72);
  --aura-vein: #cffafe;
  --aura-secondary: #67e8f9;
  --aura-shadow: rgba(34, 211, 238, 0.38);
  --pet-face-ink: #eefcff;
  --pet-face-outline: rgba(3, 7, 18, 0.78);
  --pet-face-glow: rgba(103, 232, 249, 0.28);
  --pet-console-bg: color-mix(in srgb, var(--surface) 94%, #10162b 6%);
  --pet-console-border: color-mix(in srgb, var(--aura-secondary) 24%, var(--border-strong));
  --pet-console-ink: #eef2ff;
}

.dir {
  position: absolute;
  left: 0;
  // 脸部锚点固定在 pet 坐标中；下方 name / toolbar 改变高度时只向下展开。
  bottom: 33px;
  width: 100%;
  transform: scaleX(var(--pet-direction));
  transform-origin: center bottom;
}

.sprite {
  position: relative;
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
    cursor: grab;
  }
}

.face-shell,
.face,
.hand {
  position: relative;
  display: inline-grid;
  place-items: center;
  line-height: 1;
}

.face-shell {
  isolation: isolate;
}

.face {
  z-index: 1;
  min-width: 26px;
  padding: 0 2px;
  color: var(--pet-face-ink);
  .glyph-font();
  font-size: 19px;
  font-weight: 400;
  text-shadow:
    0 1px 0 var(--pet-face-outline),
    0 0 4px var(--pet-face-glow);
  transform-origin: center;
}

.hand {
  width: 14px;
  min-height: 20px;
  z-index: 1;
  color: var(--pet-face-ink);
  .glyph-font();
  font-size: 16px;
  font-weight: 400;
  text-shadow:
    0 1px 0 var(--pet-face-outline),
    0 0 3px var(--pet-face-glow);
  transform-origin: top center;

  &.hand-left {
    justify-self: end;
  }
  &.hand-right {
    justify-self: start;
  }
}

.meta-row {
  position: absolute;
  left: 50%;
  top: calc(100% + 3px);
  display: inline-flex;
  flex-direction: column;
  align-items: stretch;
  overflow: visible;
  border: 1px solid var(--pet-console-border);
  border-radius: 8px;
  background: var(--pet-console-bg);
  box-shadow:
    0 4px 12px rgba(15, 23, 42, 0.18),
    inset 0 1px 0 color-mix(in srgb, white 62%, transparent);
  transform: translateX(-50%) scaleX(var(--pet-direction));
  transition:
    border-radius 180ms ease,
    box-shadow 180ms ease;
}

.meta-row :deep(.pet-toolbar) {
  max-height: 0;
  border-top-color: transparent;
  opacity: 0;
  overflow: hidden;
  visibility: hidden;
  transform: translateY(-3px);
  transition:
    max-height 180ms ease,
    opacity 140ms ease,
    transform 180ms ease,
    border-color 180ms ease,
    visibility 0s linear 180ms;
}

.pet:hover .meta-row,
.pet:focus-within .meta-row {
  border-radius: 8px 8px 7px 7px;
  box-shadow:
    0 6px 16px rgba(15, 23, 42, 0.22),
    0 0 0 1px color-mix(in srgb, var(--aura-secondary) 10%, transparent),
    inset 0 1px 0 color-mix(in srgb, white 66%, transparent);
}

.pet:hover .meta-row :deep(.pet-toolbar),
.pet:focus-within .meta-row :deep(.pet-toolbar) {
  max-height: 27px;
  border-top-color: color-mix(in srgb, var(--pet-console-border) 68%, transparent);
  opacity: 1;
  overflow: visible;
  visibility: visible;
  transform: translateY(0);
  transition-delay: 0s;
}

/* RunningTools 锚定绝对定位的 meta-row 底部；工具数量和工具栏展开都只向下延伸。 */
.running-row {
  position: absolute;
  left: 50%;
  top: 100%;
  display: flex;
  justify-content: center;
  transform: translateX(-50%);
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

@media (hover: none) {
  .meta-row :deep(.pet-toolbar) {
    max-height: 27px;
    border-top-color: color-mix(in srgb, var(--pet-console-border) 68%, transparent);
    opacity: 1;
    overflow: visible;
    visibility: visible;
    transform: none;
  }
}
</style>
