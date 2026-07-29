<script setup lang="ts">
/**
 * PetFaceFlip：子 pet 3D 翻转脸卡（front + back 双面，绕 Y 轴翻转）。
 * 从 PetBody 拆出（纯展示）。主 pet 单 face 路径不在本组件。
 * 翻转方向由 CSS var --pet-direction 控制（DOM 继承自父）。
 */
import { motion } from 'motion-v'
import type { VariantType } from 'motion-v'

const MotionSpan = motion.span

defineProps<{
  faceGlyph: string
  faceMotion: { animate: VariantType; transition: VariantType['transition'] }
}>()
</script>

<template>
  <span class="face-flip">
    <span class="face-rotate">
      <span class="face-side front">
        <MotionSpan
          class="face"
          :initial="false"
          :animate="faceMotion.animate"
          :transition="faceMotion.transition"
          >{{ faceGlyph }}</MotionSpan
        >
      </span>
      <span class="face-side back">
        <MotionSpan
          class="face"
          :initial="false"
          :animate="faceMotion.animate"
          :transition="faceMotion.transition"
          >{{ faceGlyph }}</MotionSpan
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
  display: inline-grid;
  place-items: center;
  line-height: 1;
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
</style>
