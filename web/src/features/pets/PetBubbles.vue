<script setup lang="ts">
/**
 * PetBubbles：所有气泡 AnimatePresence 块（approval / error / work-main / speech / side-thinking）。
 * 接收 useStreamBubble 的展示状态 + usePetStyles 的样式/motion 计算值。
 * 支持可选 dialog 插槽透传（speech 气泡内）。
 */
import { AnimatePresence, motion } from "motion-v";
import type { Ref } from "vue";
import ApprovalCard from "@/features/agent/ApprovalCard.vue";
import type { StreamState } from "@/stores";
import type { PetInstance } from "./types";

const MotionDiv = motion.div;

defineEmits<{
  bubbleEnter: [];
  bubbleLeave: [];
}>();

defineProps<{
  pet: PetInstance;
  stream?: StreamState;
  // display state (from useStreamBubble)
  hasStream: boolean;
  isBusy: boolean;
  showWorkMain: boolean;
  showWorkSide: boolean;
  thinkingOnly: boolean;
  hasContent: boolean;
  displayThinking: string;
  displayContent: string;
  renderedContent: string;
  // style computeds
  speechStyle: Record<string, string>;
  sideBubbleStyle: Record<string, string>;
  approvalStyle: Record<string, string>;
  // motion configs
  speech: {
    initial: Record<string, unknown>;
    animate: Record<string, unknown>;
    exit: Record<string, unknown>;
    transition: Record<string, unknown>;
  };
  workSideMotion: {
    initial: Record<string, unknown>;
    animate: Record<string, unknown>;
    exit: Record<string, unknown>;
    transition: Record<string, unknown>;
  };
  // scroll handler (from useStreamBubble, bound via workTextRef)
  workTextRef: Ref<HTMLElement | null>;
  onWorkTextScroll: (e: Event) => void;
}>();

defineSlots<{
  dialog?: (props: { pet: PetInstance }) => unknown;
}>();
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="stream?.approval"
      key="approval"
      class="speech approval-bubble"
      :style="approvalStyle"
      :initial="speech.initial"
      :animate="speech.animate"
      :exit="speech.exit"
      :transition="speech.transition"
    >
      <ApprovalCard :approval="stream!.approval!" :chat-id="pet.chatId" />
    </MotionDiv>
    <MotionDiv
      v-else-if="stream?.error"
      key="work-error"
      class="speech work-bubble error-bubble"
      :style="speechStyle"
      :initial="speech.initial"
      :animate="speech.animate"
      :exit="speech.exit"
      :transition="speech.transition"
    >
      <div class="work-text error-text">⚠ {{ stream.error }}</div>
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
      @pointerenter="$emit('bubbleEnter')"
      @pointerleave="$emit('bubbleLeave')"
    >
      <div :ref="workTextRef" class="work-text" :class="{ 'is-thinking': thinkingOnly }" @scroll="onWorkTextScroll">
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
      @pointerenter="$emit('bubbleEnter')"
      @pointerleave="$emit('bubbleLeave')"
    >
      <div class="work-text is-thinking">{{ displayThinking }}</div>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import "@/styles/markdown.less";
@ink: #14161a;

.speech {
  position: absolute;
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

.work-bubble {
  max-width: 180px;
  max-height: 140px;
  padding: 5px 0 5px 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  &.is-thinking {
    background: rgba(240, 238, 245, 0.92);
    border-color: rgba(140, 130, 170, 0.4);
    border-style: dashed;
  }

  &.side {
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
    padding-right: 8px;
    scrollbar-width: thin;
    scrollbar-color: rgba(20, 22, 26, 0.25) transparent;

    &::-webkit-scrollbar { width: 4px; }
    &::-webkit-scrollbar-track { background: transparent; }
    &::-webkit-scrollbar-thumb {
      background: rgba(20, 22, 26, 0.25);
      border-radius: 2px;
      &:hover { background: rgba(20, 22, 26, 0.4); }
    }

    &.is-thinking {
      color: fade(@ink, 64%);
      font-style: italic;
    }

    .md {
      white-space: normal;
      .md-content();
      // bubble-specific overrides (smaller font for compact pet bubble)
      :deep(p) { font-size: 10px; }
      :deep(h1), :deep(h2), :deep(h3), :deep(h4) { font-size: 11px; }
      :deep(code) { font-size: 9px; }
    }
  }
}

.approval-bubble {
  max-width: 220px;
  padding: 5px 8px;
  background: rgba(255, 248, 235, 0.96);
  border-color: rgba(234, 88, 12, 0.42);
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
