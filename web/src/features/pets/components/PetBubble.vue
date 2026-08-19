<script setup lang="ts">
/**
 * PetBubble：统一气泡 motion 包装器（5 variant：question / approval / error / work / speech）。
 * 从 PetBubbles 拆出。收口 :initial/:animate/:exit/:transition motion 样板 + .speech 基类 + ::after 尾箭头。
 * 内容由默认 slot 提供；work variant 额外支持 isThinking/isSub 类标记 + enter/leave 事件（思考气泡 hover 显隐）。
 * variant 类（.work-bubble/.approval-bubble 等）落在本组件根，base .speech + ::after 亦在此；
 * 气泡内部 .work-text/.error-text 等内容样式仍由 PetBubbles 通过 scoped + 组件根 data-v 继承匹配。
 */
import { computed } from 'vue'
import { motion } from 'motion-v'
import type { VariantType } from 'motion-v'

const MotionDiv = motion.div

const props = defineProps<{
  variant: 'question' | 'approval' | 'error' | 'work' | 'speech'
  speech: {
    initial: VariantType
    animate: VariantType
    exit: VariantType
    transition: VariantType['transition']
  }
  style?: Record<string, string>
  isThinking?: boolean
  isSub?: boolean
}>()

const emit = defineEmits<{
  enter: []
  leave: []
}>()

const bubbleClass = computed(() => {
  switch (props.variant) {
    case 'question':
      return 'question-bubble'
    case 'approval':
      return 'approval-bubble'
    case 'error':
      return 'work-bubble error-bubble'
    case 'work':
      return ['work-bubble', { 'is-thinking': props.isThinking, 'is-sub': props.isSub }]
    case 'speech':
      return ''
  }
  return '' // exhaustive fallback（union 已全覆盖，满足 vue/return-in-computed-property）
})
</script>

<template>
  <MotionDiv
    class="speech"
    :class="bubbleClass"
    :style="style"
    :initial="speech.initial"
    :animate="speech.animate"
    :exit="speech.exit"
    :transition="speech.transition"
    @pointerenter="emit('enter')"
    @pointerleave="emit('leave')"
  >
    <slot />
  </MotionDiv>
</template>

<style scoped lang="less">
.speech {
  position: absolute;
  min-width: 28px;
  max-width: 96px;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--ink);
  // 实底化（取代 --surface-soft 半透明）：深色主题下 --surface-soft 仅 7% 白近乎全透，
  // 文字不可见；改 94% 不透明表面色，透明窗任何场景文字清晰（保留轻微通透感）。
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.16);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.2;
  overflow-wrap: anywhere;
  transform-origin: center bottom;

  &::after {
    content: '';
    position: absolute;
    left: 14px;
    bottom: -5px;
    width: 8px;
    height: 8px;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--surface) 94%, transparent);
    transform: rotate(45deg);
    pointer-events: none;
  }
}

.work-bubble {
  max-width: 180px;
  max-height: 140px;
  padding: 5px 0 5px 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.35;
  overflow: visible; /* 放行 thinking-flyout 溢出；work-text 自身 overflow 裁内容不依赖此处 */
  display: flex;
  flex-direction: column;

  &.is-thinking {
    background: var(--panel);
    border-color: color-mix(in srgb, var(--neon-indigo) 40%, transparent);
    border-style: dashed;
  }
}

.approval-bubble {
  max-width: 220px;
  padding: 5px 8px;
  background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);

  &::after {
    border-right-color: color-mix(in srgb, var(--accent) 45%, transparent);
    border-bottom-color: color-mix(in srgb, var(--accent) 45%, transparent);
    background: color-mix(in srgb, var(--accent) 14%, var(--surface));
  }
}

.question-bubble {
  max-width: 230px;
  padding: 6px 9px;
  background: color-mix(in srgb, var(--neon-indigo) 12%, var(--surface));
  border-color: color-mix(in srgb, var(--neon-indigo) 42%, transparent);
}

.error-bubble {
  max-width: 240px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  border-color: color-mix(in srgb, var(--danger) 55%, transparent);
  color: var(--danger);
}
</style>
