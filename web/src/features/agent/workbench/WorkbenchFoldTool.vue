<script setup lang="ts">
import type { FoldMode, useWorkbenchDialogController } from './useWorkbenchDialogController'
type Controller = ReturnType<typeof useWorkbenchDialogController>
defineProps<{
  foldMode: FoldMode
  foldToolOpen: boolean
  icons: Controller['FOLD_ICONS']
  tips: Controller['FOLD_TIPS']
}>()
const emit = defineEmits<{
  show: []
  'schedule-close': []
  select: [mode: FoldMode]
}>()
</script>

<template>
  <div
    class="nyxus-fold-tool"
    :class="{ 'is-open': foldToolOpen }"
    @pointerenter="emit('show')"
    @focusin="emit('show')"
    @pointerleave="emit('schedule-close')"
  >
    <el-tooltip
      v-for="mode in ['none', 'partial', 'participant', 'full'] as FoldMode[]"
      :key="mode"
      :content="tips[mode]"
      placement="top"
      :show-after="200"
      :hide-after="0"
    >
      <button
        type="button"
        class="nyxus-fold-part"
        :class="{ 'is-selected': foldMode === mode }"
        :aria-label="tips[mode]"
        :aria-pressed="foldMode === mode"
        @click="emit('select', mode)"
      >
        <svg class="nyxus-fold-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            v-for="path in icons[mode].paths"
            :key="path"
            class="nyxus-fold-icon-edge"
            :d="path"
          />
          <circle
            v-for="([cx, cy], index) in icons[mode].nodes"
            :key="`${cx}-${cy}-${index}`"
            class="nyxus-fold-icon-node"
            :cx="cx"
            :cy="cy"
            r="1.65"
          />
        </svg>
      </button>
    </el-tooltip>
    <span class="nyxus-fold-current" aria-hidden="true">
      <svg class="nyxus-fold-icon" viewBox="0 0 24 24">
        <path
          v-for="path in icons[foldMode].paths"
          :key="path"
          class="nyxus-fold-icon-edge"
          :d="path"
        />
        <circle
          v-for="([cx, cy], index) in icons[foldMode].nodes"
          :key="`${cx}-${cy}-${index}`"
          class="nyxus-fold-icon-node"
          :cx="cx"
          :cy="cy"
          r="1.65"
        />
      </svg>
    </span>
  </div>
</template>

<style scoped lang="less">
/* 折叠四档按钮：复用同一个外边框，hover 时水平变宽，左侧滑出 4 个子按钮，
   右侧保持当前档 icon。子按钮在流内，随容器一起把 rail 列撑宽，不触发裁剪。 */
.nyxus-fold-tool {
  position: relative;
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  align-items: center;
  gap: 2px;
  height: 30px;
  width: 30px;
  padding: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
  border-radius: 10px;
  color: color-mix(in srgb, var(--nx-text) 64%, transparent);
  background: color-mix(in srgb, var(--nx-bg) 55%, transparent);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(9px) saturate(115%);
  pointer-events: auto;
  transition: width 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.nyxus-fold-tool.is-open {
  /* 4 个子按钮(30 各) + 当前 icon(30) + 3×2 gap */
  width: 156px;
}
.nyxus-fold-part,
.nyxus-fold-current {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  font-size: 12px;
  line-height: 1;
}
.nyxus-fold-part {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transform: translateX(-6px);
  transition:
    opacity 120ms ease,
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease;
}
.nyxus-fold-tool.is-open .nyxus-fold-part {
  opacity: 1;
  transform: translateX(0);
}
.nyxus-fold-part:hover,
.nyxus-fold-part.is-selected {
  color: var(--nx-text);
}
.nyxus-fold-icon {
  width: 18px;
  height: 18px;
  overflow: visible;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.45;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.nyxus-fold-icon-edge {
  opacity: 0.72;
}
.nyxus-fold-icon-node {
  fill: color-mix(in srgb, currentColor 18%, var(--nx-bg));
  stroke-width: 1.35;
}
.nyxus-fold-part:hover .nyxus-fold-icon-edge,
.nyxus-fold-part.is-selected .nyxus-fold-icon-edge,
.nyxus-fold-current .nyxus-fold-icon-edge {
  opacity: 1;
}
.nyxus-fold-part.is-selected .nyxus-fold-icon-node,
.nyxus-fold-current .nyxus-fold-icon-node {
  fill: color-mix(in srgb, currentColor 34%, var(--nx-bg));
}
</style>
