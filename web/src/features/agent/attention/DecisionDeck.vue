<script setup lang="ts">
import { computed } from 'vue'
import type { InteractionRecord } from '@/application/backend/public'
import InteractionCard from './InteractionCard.vue'
import { titleOf } from './interactionPresentation'

const props = defineProps<{
  items: InteractionRecord[]
  activeIndex: number
  /** 当前批次卡内显示的题目下标（标题栏 ← 题目 n/N → 切换）。 */
  questionIndex: number
  now: number
}>()
const emit = defineEmits<{
  activate: [index: number]
}>()

// 纸牌堆叠：每批次一张卡，活动卡整卡展示；非活动卡在左侧漏边堆叠（一次抓多张纸牌的效果，
// 左边露出带序号与类型色的卡片边缘，点击任一漏边即把该批次切到上层）。
const DECK_PEEK = 28 // 每张卡漏出的左侧边宽
const DECK_FAN_CAP = 6 // 最多同时漏出几张边（再多走标题栏分页兜底）

/** 非活动卡数量与可漏边深度。 */
const behindCount = computed(() => Math.max(props.items.length - 1, 0))
const fanDepth = computed(() => Math.min(behindCount.value, DECK_FAN_CAP - 1))

/** 堆叠区左侧预留：活动卡右移，让漏边露在窗口内。 */
function deckStackStyle(): Record<string, string> {
  return { paddingLeft: `${fanDepth.value * DECK_PEEK}px` }
}
/**
 * 非活动卡漏边错位：越靠后漏得越多（最近一张只漏一条边）。
 * 左偏移按 depth 递减，保证每张漏边区互不重叠、点击各自命中；
 * z-index 随 depth 递减（活动卡 z=10 恒在其上），让「更靠后」的卡被「更靠前」的卡盖住右半部分。
 */
function deckCardStyle(index: number): Record<string, string> {
  if (index === props.activeIndex) return {}
  const depth = index < props.activeIndex ? index : index - 1
  const left = Math.max((fanDepth.value - 1 - depth) * DECK_PEEK, 0)
  return {
    left: `${left}px`,
    top: `${(depth + 1) * 5}px`,
    height: `calc(100% - ${(depth + 1) * 5}px)`,
    zIndex: `${fanDepth.value - depth}`,
  }
}
</script>

<template>
  <TransitionGroup name="deck" tag="div" class="deck-stack" :style="deckStackStyle()">
    <template v-for="(item, index) in items" :key="item.interactionId">
      <button
        v-if="index !== activeIndex"
        :key="`edge-${item.interactionId}`"
        type="button"
        class="deck-edge"
        :class="item.kind === 'approval' ? 'is-approval' : 'is-question'"
        :style="deckCardStyle(index)"
        :aria-label="`切换到批次 ${index + 1}/${items.length}：${titleOf(item)}`"
        :title="`批次 ${index + 1}：${titleOf(item)}`"
        @click="emit('activate', index)"
      >
        <span class="deck-edge-kind">{{
          item.kind === 'approval' ? '确认' : '回答'
        }}</span>
        <span class="deck-edge-num">{{ index + 1 }}</span>
      </button>
      <InteractionCard
        v-else
        :key="`card-${item.interactionId}`"
        class="deck-card is-active"
        :item="item"
        :now="now"
        :show-footer="false"
        :question-index="questionIndex"
        title-always
      />
    </template>
  </TransitionGroup>
</template>

<style scoped lang="less">
.deck-stack {
  position: relative;
}
// 非活动批次漏边：整卡高的卡片边缘，左侧 3px 实色边条标识类型（金=确认 / 紫=回答），
// 边缘内显示类型短名与批次序号，hover 可见完整标题；点击切换到上层。直角、400 字重、token 派生色。
.deck-edge {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 1;
  width: 56px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-left-width: 3px;
  background: var(--surface);
  cursor: pointer;
}
.deck-edge.is-approval {
  border-left-color: #d88a26;
}
.deck-edge.is-approval .deck-edge-kind {
  color: #d88a26;
}
.deck-edge.is-question {
  border-left-color: #7c3aed;
}
.deck-edge.is-question .deck-edge-kind {
  color: #7c3aed;
}
.deck-edge:hover {
  border-left-width: 4px;
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.deck-edge-kind {
  position: absolute;
  left: 6px;
  top: 7px;
  font-size: 10px;
  font-weight: 400;
  white-space: nowrap;
}
.deck-edge-num {
  position: absolute;
  left: 6px;
  top: 23px;
  min-width: 14px;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 400;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
}
// 活动卡整卡：叠在漏边之上（z=10 恒高于漏边卡 z≤5）。
.deck-card.is-active {
  position: relative;
  z-index: 10;
  border-radius: 0;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
}
.deck-card.is-active.is-blocked {
  border-color: #e59a35;
}
// 切换 / 提交抽出动画：只淡入淡出，避免位移抖动。
.deck-enter-active,
.deck-leave-active {
  transition: opacity 0.16s ease;
}
.deck-enter-from,
.deck-leave-to {
  opacity: 0;
}
</style>
