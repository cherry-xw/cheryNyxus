<script setup lang="ts">
/**
 * PetFaceFlip：子 pet 3D 翻转脸卡（front + back 双面，绕 Y 轴翻转）。
 * 从 PetBody 拆出（纯展示）。主 pet 单 face 路径不在本组件。
 * 翻转方向由 CSS var --pet-direction 控制（DOM 继承自父）。
 */
import { ref, toRef } from 'vue'
import type { PetMotionDescriptor } from '@/domain/pets/motion/animation'
import { usePetMotion } from '../composables/usePetMotion'
import PetDivineHalo from './PetDivineHalo.vue'

const props = defineProps<{
  faceGlyph: string
  faceMotion: PetMotionDescriptor
  active?: boolean
}>()
const frontRef = ref<HTMLElement | null>(null)
const backRef = ref<HTMLElement | null>(null)
usePetMotion(frontRef, toRef(props, 'faceMotion'))
usePetMotion(backRef, toRef(props, 'faceMotion'))
</script>

<template>
  <span class="face-flip">
    <PetDivineHalo :active="active" />
    <span class="face-rotate">
      <span class="face-side front">
        <span
          ref="frontRef"
          class="face"
          >{{ faceGlyph }}</span
        >
      </span>
      <span class="face-side back">
        <span
          ref="backRef"
          class="face"
          >{{ faceGlyph }}</span
        >
      </span>
    </span>
  </span>
</template>

<style scoped lang="less">
@glyph-fonts: ui-rounded, 'Hiragino Sans', 'PingFang SC', 'Noto Sans Symbols 2',
  'Noto Sans Symbols', 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', sans-serif;

.glyph-font() {
  font-family: @glyph-fonts;
}

.face {
  position: relative;
  z-index: 1;
  display: inline-grid;
  place-items: center;
  line-height: 1;
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

.face-flip {
  position: relative;
  isolation: isolate;
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
</style>
