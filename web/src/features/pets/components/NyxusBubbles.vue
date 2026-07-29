<script setup lang="ts">
/**
 * NyxusBubbles：nyxus 独立核心的精简工作气泡。
 * 仅 error tier（stream.error）+ work-main tier（thinking/content + thinking flyout）。
 * 不含 approval/question/speech（走 AgentDialog）。状态来自 useStreamBubble（经 NyxusCore 注入）。
 */
import { AnimatePresence, motion } from 'motion-v'
import type { StreamState } from '@/stores'

const MotionDiv = motion.div

defineEmits<{
  bubbleEnter: []
  bubbleLeave: []
}>()

const props = defineProps<{
  stream?: StreamState
  showWorkMain: boolean
  showThinkingButton: boolean
  thinkingOnly: boolean
  hasContent: boolean
  displayThinking: string
  displayContent: string
  renderedContent: string
  workTextRef: (el: HTMLElement | null) => void
  onWorkTextScroll: (e: Event) => void
}>()

// 进出场 motion（自建简化版，不依赖 usePetStyles）
const initial = { opacity: 0, y: 8, scale: 0.9 }
const animate = { opacity: 1, y: 0, scale: 1 }
const exit = { opacity: 0, scale: 0.9 }
const transition = { duration: 0.18 }
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="props.stream?.error"
      key="work-error"
      class="speech work-bubble error-bubble"
      :initial="initial"
      :animate="animate"
      :exit="exit"
      :transition="transition"
    >
      <div class="work-text error-text">⚠ {{ props.stream.error }}</div>
    </MotionDiv>
    <MotionDiv
      v-else-if="props.showWorkMain"
      key="work-main"
      class="speech work-bubble"
      :class="{ 'is-thinking': props.thinkingOnly }"
      :initial="initial"
      :animate="animate"
      :exit="exit"
      :transition="transition"
      @pointerenter="$emit('bubbleEnter')"
      @pointerleave="$emit('bubbleLeave')"
    >
      <div
        :ref="(el) => props.workTextRef(el as HTMLElement | null)"
        class="work-text"
        :class="{ 'is-thinking': props.thinkingOnly }"
        @scroll="props.onWorkTextScroll"
      >
        <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义，XSS 安全 -->
        <span v-if="props.hasContent" class="md" v-html="props.renderedContent" />
        <template v-else>{{ props.displayThinking }}</template>
      </div>
      <!-- thinking 按钮：思考结束后锚 content 气泡左外侧（🤔）；hover 向左上拉伸显思考框 -->
      <div v-if="props.showThinkingButton" class="thinking-trigger" aria-label="查看 thinking">
        <span class="thinking-icon" aria-hidden="true">🤔</span>
        <div class="thinking-flyout" role="tooltip">{{ props.displayThinking }}</div>
      </div>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import '@/styles/markdown.less';
@ink: #14161a;

/* 气泡锚 nyxus 粒子上方：aside 是 1px fixed 点（=粒子中心），水平居中、上浮粒子半径+间距 */
.speech {
  position: absolute;
  left: 0;
  bottom: 70px;
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
  transform: translateX(-50%);
  transform-origin: center bottom;

  &::after {
    content: '';
    position: absolute;
    left: 50%;
    margin-left: -4px;
    bottom: -5px;
    width: 8px;
    height: 8px;
    border-right: 1px solid rgba(255, 255, 255, 0.74);
    border-bottom: 1px solid rgba(255, 255, 255, 0.74);
    background: rgba(255, 255, 255, 0.92);
    transform: rotate(45deg);
    pointer-events: none;
  }
}

.work-bubble {
  max-width: 220px;
  max-height: 160px;
  padding: 5px 0 5px 8px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  overflow: visible;
  display: flex;
  flex-direction: column;

  &.is-thinking {
    background: rgba(240, 238, 245, 0.92);
    border-color: rgba(140, 130, 170, 0.4);
    border-style: dashed;
  }

  .work-text {
    flex: 1;
    overflow: auto;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    font-weight: 400;
    padding-right: 8px;
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

    .md {
      white-space: normal;
      .md-content();
      :deep(p) {
        font-size: 11px;
      }
      :deep(h1),
      :deep(h2),
      :deep(h3),
      :deep(h4) {
        font-size: 12px;
      }
      :deep(code) {
        font-size: 10px;
      }
    }
  }

  .thinking-trigger {
    position: absolute;
    right: 100%;
    bottom: -1px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    line-height: 1;
    cursor: default;
    user-select: none;

    .thinking-icon {
      font-size: 13px;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.15));
      transition: transform 140ms ease;
    }

    &:hover .thinking-icon {
      transform: scale(1.15);
    }

    &:hover .thinking-flyout {
      transform: scale(1);
      opacity: 1;
      pointer-events: auto;
    }
  }

  .thinking-flyout {
    position: absolute;
    right: 0;
    bottom: 0;
    z-index: 30;
    box-sizing: border-box;
    width: 200px;
    max-height: 150px;
    padding: 5px 7px;
    border-radius: 7px;
    border: 1px dashed rgba(140, 130, 170, 0.4);
    background: rgba(240, 238, 245, 0.97);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
    color: fade(@ink, 64%);
    font-size: 9.5px;
    font-weight: 400;
    font-style: italic;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow: auto;
    text-align: left;
    transform: scale(0);
    transform-origin: bottom right;
    opacity: 0;
    pointer-events: none;
    transition:
      transform 180ms ease,
      opacity 140ms ease;
  }
}

.error-bubble {
  max-width: 240px;
  padding: 6px 10px;
  background: rgba(254, 226, 226, 0.96);
  border-color: rgba(220, 38, 38, 0.55);
  color: #7f1d1d;
}

.error-bubble .error-text {
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
}
</style>
