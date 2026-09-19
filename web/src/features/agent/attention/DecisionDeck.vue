<script setup lang="ts">
import { computed } from 'vue'
import type { InteractionRecord } from '@/application/backend/public'
import InteractionCard from './InteractionCard.vue'

const props = defineProps<{
  items: InteractionRecord[]
  activeIndex: number
  /** 当前批次卡内显示的题目下标（底部栏 ← 题目 n/N → 切换）。 */
  questionIndex: number
  now: number
}>()

/** 当前展示批次卡（批次切换走标题栏 ← 批次 n/N →，不再堆叠漏边）。 */
const activeItem = computed(() => props.items[props.activeIndex] ?? null)
</script>

<template>
  <Transition name="deck" mode="out-in">
    <InteractionCard
      v-if="activeItem"
      :key="activeItem.interactionId"
      class="deck-card is-active"
      :item="activeItem"
      :now="now"
      :show-footer="false"
      :question-index="questionIndex"
    />
  </Transition>
</template>

<style scoped lang="less">
// 单卡展示：切换批次时只淡入淡出，避免位移抖动。
.deck-card.is-active {
  border-radius: 0;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
}
.deck-card.is-active.is-blocked {
  border-color: #e59a35;
}
.deck-enter-active,
.deck-leave-active {
  transition: opacity 0.16s ease;
}
.deck-enter-from,
.deck-leave-to {
  opacity: 0;
}
</style>
