<script setup lang="ts">
/**
 * 上下文用量条：6 段分段彩色条 + 行内图例（短标签·色点文字·tokens） + used/total/占比。
 * 逻辑原属 HistoryDrawerPanel，抽离为共享组件供两处复用：
 *  - variant="inline"  ：抽屉头部条（label 槽位 + legend + values + 3px 色块 track）。
 *  - variant="divider" ：节点树工作台分割线（默认仅 4px 细线可见；hover 变宽并展开 legend/values）。
 * 依赖共享工具 contextBreakdown.ts（breakdownSegments/fmtTokens/segmentThinkingNote）+ BREAKDOWN_SEGMENTS 段元数据。
 */
import { computed } from 'vue'
import {
  breakdownSegments,
  fmtTokens,
  segmentThinkingNote,
} from '../toolbar/contextBreakdown'
import type { BreakdownKey } from '../toolbar/contextBreakdown'
import type { ContextBreakdown } from '@/services/agentApi'

const props = withDefaults(
  defineProps<{
    /** 整体占用比例 0-1（severity 分级 + 退化单段条宽度用）。 */
    usage: number
    /** 6 段分解；缺省时退化为单段 fill。 */
    breakdown?: ContextBreakdown | null
    /** inline=抽屉头部条；divider=工作台分割线（hover 展开）。 */
    variant?: 'inline' | 'divider'
  }>(),
  { breakdown: null, variant: 'inline' },
)

/** contextUsage 颜色分级（<50% 绿 / 50-80% 黄 / >80% 红，与 ContextBar / SessionList 对齐）。 */
function usageClass(u: number): string {
  if (u >= 0.8) return 'usage-high'
  if (u >= 0.5) return 'usage-mid'
  return 'usage-low'
}

const usagePct = computed(() => Math.round(props.usage * 100))
const usageDetail = computed(() => {
  const bd = props.breakdown
  if (!bd || bd.total <= 0) return null
  return { used: Math.round(bd.total * bd.usage), total: bd.total }
})
/** allSegs 全量（图例，0 段灰色展示完整类目）；usageSegs 过滤 token=0（色块条，避空类 min-width 噪声）。 */
const allSegs = computed(() => breakdownSegments(props.breakdown))
const usageSegs = computed(() => allSegs.value.filter((s) => s.tokens > 0))

/** 行内图例短标签（区别于 ContextBreakdownTip 全称，适配单行紧凑布局）。 */
const SHORT_LABELS: Record<BreakdownKey, string> = {
  system: '系统',
  userSystem: '用户',
  memory: '记忆',
  skills: '技能',
  tools: '工具',
  conversation: '对话',
}
function shortLabel(key: BreakdownKey): string {
  return SHORT_LABELS[key] ?? key
}

/** 图例标签文字色定义在 scoped CSS（label-${key} 类），并随 [data-theme='dark'] 提亮。 */
</script>

<template>
  <div
    class="ctx-usage-bar"
    :class="[usageClass(usage), `is-${variant}`]"
  >
    <div class="ctx-usage-row">
      <slot name="label" />
      <div v-if="allSegs.length" class="ctx-usage-legend">
        <span
          v-for="seg in allSegs"
          :key="seg.key"
          class="ctx-legend-item"
          :class="{ 'is-zero': seg.tokens === 0 }"
        >
          <span
            class="ctx-legend-label"
            :class="[`label-${seg.key}`, { 'is-zero': seg.tokens === 0 }]"
            >{{ shortLabel(seg.key) }}</span
          >
          <span v-if="segmentThinkingNote(seg)" class="ctx-legend-thinking">{{
            segmentThinkingNote(seg)
          }}</span>
          <span class="ctx-legend-tokens">{{ fmtTokens(seg.tokens) }}</span>
        </span>
      </div>
      <span v-if="usageDetail" class="ctx-usage-values">
        <span class="ctx-usage-used">{{ fmtTokens(usageDetail.used) }}</span>
        <span class="ctx-usage-sep">/</span>
        <span class="ctx-usage-total">{{ fmtTokens(usageDetail.total) }}</span>
        <span class="ctx-usage-pct">{{ usagePct }}%</span>
      </span>
    </div>
    <div class="ctx-usage-track" role="img" :aria-label="`上下文占用 ${usagePct}%`">
      <template v-if="usageSegs.length">
        <div
          v-for="seg in usageSegs"
          :key="seg.key"
          class="ctx-usage-seg"
          :style="{ width: `${seg.pct}%`, background: seg.color }"
        />
      </template>
      <div
        v-else
        class="ctx-usage-fill"
        :style="{ width: `${Math.min(100, usagePct)}%` }"
      />
    </div>
  </div>
</template>

<style scoped lang="less">
.ctx-usage-bar {
  display: flex;
  flex-direction: column;

  &.usage-low {
    --usage-color: #22c55e;
    --usage-bg: rgba(34, 197, 94, 0.18);
  }
  &.usage-mid {
    --usage-color: #eab308;
    --usage-bg: rgba(234, 179, 8, 0.22);
  }
  &.usage-high {
    --usage-color: #ef4444;
    --usage-bg: rgba(239, 68, 68, 0.22);
  }

  // ── 共享：图例行 + 数值（短标签小字，两变体复用）──
  .ctx-usage-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .ctx-usage-legend {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    row-gap: 2px;
    column-gap: 6px;
    overflow: hidden;
  }
  .ctx-legend-item {
    display: inline-flex;
    align-items: baseline;
    gap: 2px;
    font-size: 9px;
    line-height: 1;
    white-space: nowrap;
  }
  .ctx-legend-item.is-zero .ctx-legend-tokens {
    opacity: 0.5;
  }
  .ctx-legend-label {
    font-weight: 600;
    &.is-zero {
      color: rgba(20, 22, 26, 0.38);
    }
  }
  // 图例标签类别色（加深版，区别于色块条鲜艳色：amber/green 原色在浅底对比不足）。
  .label-system { color: #4338ca; }
  .label-userSystem { color: #7e22ce; }
  .label-memory { color: #be185d; }
  .label-skills { color: #b45309; }
  .label-tools { color: #047857; }
  .label-conversation { color: #1d4ed8; }
  // 深色模式提亮标签色（深底用更浅的同色系），保持可读。
  :global([data-theme='dark']) {
    .label-system { color: #a5b4fc; }
    .label-userSystem { color: #d8b4fe; }
    .label-memory { color: #f9a8d4; }
    .label-skills { color: #fcd34d; }
    .label-tools { color: #34d399; }
    .label-conversation { color: #93c5fd; }
    .ctx-legend-label.is-zero { color: rgba(235, 238, 244, 0.38); }
  }
  .ctx-legend-thinking {
    opacity: 0.55;
  }
  .ctx-legend-tokens {
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--ink) 60%, transparent);
  }
  .ctx-usage-values {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 78%, transparent);
  }
  .ctx-usage-used {
    color: var(--usage-color);
    font-weight: 800;
  }
  .ctx-usage-sep {
    opacity: 0.5;
  }
  .ctx-usage-total {
    opacity: 0.7;
  }
  .ctx-usage-pct {
    margin-left: 6px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--usage-bg);
    color: var(--usage-color);
    font-weight: 800;
    font-size: 10px;
  }

  // ── 共享：分段条。track 负责容器；seg 有 min-width，数据只剩一点点也有最基础色块宽度。──
  .ctx-usage-track {
    display: flex;
    overflow: hidden;
  }
  .ctx-usage-seg {
    height: 100%;
    flex-shrink: 0;
    min-width: 8px;
    transition: width 0.3s ease;
  }
  .ctx-usage-fill {
    height: 100%;
    background: var(--usage-color);
    transition: width 0.3s ease;
  }

  // 默认布局：行在上、条在下（inline 抽屉）。
  .ctx-usage-row {
    order: 1;
  }
  .ctx-usage-track {
    order: 2;
  }

  // ===== inline：抽屉头部条（原 HistoryDrawerPanel .usage-bar-wrap）。=====
  &.is-inline {
    padding: 6px 14px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
    background: var(--surface-soft);
    gap: 4px;

    .ctx-usage-track {
      height: 3px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--ink) 8%, transparent);
      gap: 2px;
    }
    .ctx-usage-fill {
      border-radius: 2px;
    }
  }

  // ===== divider：工作台分割线。默认仅细线（2px）可见；hover 变宽并展开图例（条在上、行在下）。=====
  &.is-divider {
    width: 100%;

    .ctx-usage-row {
      order: 2;
      display: none;
      align-self: flex-start;
      margin-top: 2px;
      min-width: 200px;
      padding: 6px 8px;
      border-radius: 6px;
      // 工作台分割线悬浮气泡：背景随主题（浅色白底 / 深色深底），加边框 + 阴影与节点树画布区分。
      background: var(--surface);
      border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    }
    .ctx-usage-track {
      order: 1;
      height: 2px;
      // 分割线本体：底色即分割线（与标题栏 border-bottom 同色），无数据时也可见一条细线。
      background: rgba(138, 211, 228, 0.14);
      transition: height 160ms ease;
    }
    &:hover {
      .ctx-usage-row {
        display: flex;
      }
      .ctx-usage-track {
        height: 4px;
      }
    }
  }
}
</style>