<script setup lang="ts">
/**
 * ContextBar：pet 头上 contextUsage 用量 bar（44×2px）。
 * 分段（breakdown 给出）：每段 width = 该段 tokens / total，类别色；剩余为空 track。hover title 显各段明细。
 * 无 breakdown：退化为单段填充（<50% 绿 / 50-80% 黄 / >80% 红）。
 */
import { computed } from 'vue'
import type { ContextBreakdown } from '@/services/agentApi'
import { breakdownSegments, fmtTokens, segmentThinkingNote } from './contextBreakdown'

const props = defineProps<{
  usage: number // 0-1（无 breakdown 时填充 + aria 用）
  breakdown?: ContextBreakdown
}>()

const COLORS = {
  low: '#22c55e', // <50% 绿
  mid: '#eab308', // 50-80% 黄
  high: '#ef4444', // >80% 红
} as const

const clamped = computed(() => Math.min(1, Math.max(0, props.usage)))
const legacyColor = computed(() => {
  if (clamped.value >= 0.8) return COLORS.high
  if (clamped.value >= 0.5) return COLORS.mid
  return COLORS.low
})
const segs = computed(() => breakdownSegments(props.breakdown))
const titleLines = computed(() => {
  const pct = Math.round((props.breakdown?.usage ?? clamped.value) * 100)
  if (!props.breakdown) return [`上下文 ${pct}%`]
  return [
    `上下文 ${pct}%`,
    ...segs.value
      .filter((s) => s.tokens > 0)
      .map((s) => {
        const note = segmentThinkingNote(s)
        return `${s.label} ${fmtTokens(s.tokens)} · ${s.pct}%${note ? ` ${note}` : ''}`
      }),
  ]
})
</script>

<template>
  <el-tooltip placement="top" :show-after="200" :hide-after="0">
    <template #content>
      <div class="ctxbar-tip">
        <div v-for="(line, i) in titleLines" :key="i">{{ line }}</div>
      </div>
    </template>
    <div
      class="context-bar"
      role="progressbar"
      :aria-valuenow="Math.round(clamped * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="`上下文用量 ${Math.round(clamped * 100)}%`"
    >
      <template v-if="segs.length">
        <span
          v-for="s in segs"
          :key="s.key"
          class="seg"
          :style="{ width: `${s.pct}%`, background: s.color }"
        />
      </template>
      <span v-else class="fill" :style="{ width: `${clamped * 100}%`, background: legacyColor }" />
    </div>
  </el-tooltip>
</template>

<style scoped lang="less">
.context-bar {
  position: relative;
  width: 44px;
  height: 2px;
  border-radius: 1px;
  // 不透明 track（与 PetStatusBar .stat 一致）：取代 ink 14% 半透明
  background: color-mix(in srgb, var(--ink) 24%, var(--surface));
  overflow: hidden;
  display: flex;
  cursor: help;
}

.seg {
  height: 100%;
  flex-shrink: 0;
  transition: width 200ms ease;
}

.fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 1px;
  transition:
    width 200ms ease,
    background 200ms ease;
}

// 用量 tip：el-tooltip 内容，文字色随 EP 主题（深色模式 el-popper 深底浅字）
.ctxbar-tip {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
}
</style>
