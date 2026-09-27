<script setup lang="ts">
/**
 * 工作台底部 Agent 用量条：默认占据底部空间并以两行小字展示详情。
 *
 * - divider（树 / 对话）：主 Agent 一行、子 Agent 一行。
 * - lite（精简视图）：紧凑摘要——主 Agent used/total/占比 + 总耗时 + 运行中 + token 速度 +
 *   子 Agent 计数（内容精简初版，后续按精简模式 API 特性再细化）。
 *
 * 进度条固定在信息区最底部，详情默认展示。
 */
import { computed } from 'vue'
import { breakdownSegments, fmtTokens } from '../toolbar/contextBreakdown'
import { formatElapsed } from '@/features/lite/executionMonitor'
import { usageClass } from './useWorkbenchContextInspector'
import type { WorkbenchAgentUsageView } from './useWorkbenchAgentUsage'

const props = withDefaults(
  defineProps<{
    /** 全部 Agent 用量视图（主 Agent 恒在首位）。 */
    agents: WorkbenchAgentUsageView[]
    /** 采集 token 速度（tok/s）。 */
    tokenSpeed: number
    /** divider=树/对话完整档；lite=精简档。 */
    variant?: 'divider' | 'lite'
  }>(),
  { variant: 'divider' },
)

const rootAgent = computed(() => props.agents.find((agent) => agent.isRoot))
const subAgents = computed(() => props.agents.filter((agent) => !agent.isRoot))

const usedTokens = computed(() => rootAgent.value?.usedTokens ?? 0)
const totalTokens = computed(() => rootAgent.value?.totalTokens ?? 0)
const pct = computed(() => {
  const usage = rootAgent.value?.usage
  return usage === undefined ? 0 : Math.round(usage * 100)
})
const tone = computed(() => usageClass(rootAgent.value?.usage ?? 0))

const allSegs = computed(() => breakdownSegments(rootAgent.value?.breakdown ?? undefined))
const usageSegs = computed(() => allSegs.value.filter((seg) => seg.tokens > 0))
/** 是否有可用 token 数值（无则隐藏 used/total/占比行）。 */
const hasValues = computed(
  () =>
    rootAgent.value?.usage !== undefined ||
    rootAgent.value?.usedTokens !== undefined ||
    rootAgent.value?.totalTokens !== undefined,
)

/** 子 Agent token 上下文窗口：X-Y（X=已用，Y=上限）。 */
function subTokensText(sub: WorkbenchAgentUsageView): string {
  if (sub.usedTokens === undefined && sub.totalTokens === undefined) return '—'
  return `${fmtTokens(sub.usedTokens ?? 0)}-${fmtTokens(sub.totalTokens ?? 0)}`
}

/** token 速度显示：<10 保留 1 位小数，其余取整。 */
function fmtSpeed(speed: number): string {
  if (speed <= 0) return '0'
  return speed < 10 ? speed.toFixed(1) : String(Math.round(speed))
}
</script>

<template>
  <div
    class="wub-bar"
    :class="[`is-${variant}`, `is-${tone}`, { 'has-subagents': subAgents.length > 0 }]"
  >
    <!-- 详情面板：默认展示，并占据底部信息区 -->
    <div class="wub-panel">
      <!-- 完整档（树 / 对话）：主 Agent 一行 + 子 Agent 一行 -->
      <template v-if="variant === 'divider' && rootAgent">
        <div class="wub-row wub-main-row">
          <span>{{ rootAgent.label }}</span>
          <span v-if="rootAgent.model" class="wub-model">{{ rootAgent.model }}</span>
          <span v-if="rootAgent.thinkingLabel" class="wub-thinking"
            >思考 {{ rootAgent.thinkingLabel }}</span
          >
          <span v-if="rootAgent.running" class="wub-running">运行中</span>
          <span class="wub-speed">{{ fmtSpeed(tokenSpeed) }} tok/s</span>
          <span v-if="hasValues" class="wub-values"
            >{{ fmtTokens(usedTokens) }}/{{ fmtTokens(totalTokens) }} {{ pct }}%</span
          >
          <span
            v-for="seg in allSegs"
            :key="seg.key"
            class="wub-breakdown"
            :class="{ 'is-zero': seg.tokens === 0 }"
            :style="{ color: seg.color }"
          >
            {{ seg.label }} {{ fmtTokens(seg.tokens) }}
          </span>
          <time v-if="rootAgent.elapsedMs > 0" class="wub-elapsed"
            >耗时 {{ formatElapsed(rootAgent.elapsedMs) }}</time
          >
        </div>
        <div v-if="subAgents.length" class="wub-row wub-subagents">
          <div v-for="sub in subAgents" :key="sub.chatId" class="wub-subagent">
            <span>{{ sub.label }}</span>
            <span>{{ subTokensText(sub) }}</span>
            <span v-if="sub.running" class="wub-running">运行中</span>
            <time v-if="sub.elapsedMs > 0" class="wub-elapsed">{{
              formatElapsed(sub.elapsedMs)
            }}</time>
          </div>
        </div>
      </template>
      <!-- 精简档（精简视图）：紧凑摘要 -->
      <template v-else-if="variant === 'lite' && rootAgent">
        <div class="wub-row wub-main-row">
          <span>{{ rootAgent.label }}</span>
          <span v-if="rootAgent.model" class="wub-model">{{ rootAgent.model }}</span>
          <span v-if="rootAgent.thinkingLabel" class="wub-thinking"
            >思考 {{ rootAgent.thinkingLabel }}</span
          >
          <span v-if="rootAgent.running" class="wub-running">运行中</span>
          <span v-if="hasValues" class="wub-values"
            >{{ fmtTokens(usedTokens) }}/{{ fmtTokens(totalTokens) }} {{ pct }}%</span
          >
          <span class="wub-speed">{{ fmtSpeed(tokenSpeed) }} tok/s</span>
          <time v-if="rootAgent.elapsedMs > 0" class="wub-elapsed"
            >耗时 {{ formatElapsed(rootAgent.elapsedMs) }}</time
          >
        </div>
        <div v-if="subAgents.length" class="wub-row wub-subagents">
          <div v-for="sub in subAgents" :key="sub.chatId" class="wub-subagent">
            <span>{{ sub.label }}</span>
            <span>{{ subTokensText(sub) }}</span>
            <span v-if="sub.running" class="wub-running">运行中</span>
            <time v-if="sub.elapsedMs > 0" class="wub-elapsed">{{
              formatElapsed(sub.elapsedMs)
            }}</time>
          </div>
        </div>
      </template>
    </div>
    <!-- 信息区底部的分段进度条 -->
    <div class="wub-track" role="img" :aria-label="`上下文占用 ${pct}%`">
      <template v-if="usageSegs.length">
        <div
          v-for="seg in usageSegs"
          :key="seg.key"
          class="wub-seg"
          :style="{ width: `${seg.pct}%`, background: seg.color }"
        />
      </template>
      <div v-else class="wub-fill" :style="{ width: `${Math.min(100, pct)}%` }" />
    </div>
  </div>
</template>

<style scoped lang="less">
// Agent 用量信息：主 Agent 一行，存在子 Agent 时再显示第二行。
.wub-bar {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  // 上下文占用三档色（绿 / 黄 / 红，与 ContextUsageBar / ContextBar 对齐）。
  &.is-usage-low {
    --wub-color: #22c55e;
    --wub-bg: rgba(34, 197, 94, 0.16);
  }
  &.is-usage-mid {
    --wub-color: #eab308;
    --wub-bg: rgba(234, 179, 8, 0.18);
  }
  &.is-usage-high {
    --wub-color: #ef4444;
    --wub-bg: rgba(239, 68, 68, 0.18);
  }

  // 信息面板默认占据底部区域；内容过多时在条内滚动，不覆盖工作台主体。
  .wub-panel {
    order: 1;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    align-self: stretch;
    box-sizing: border-box;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    max-width: none;
    margin: 0;
    padding: 0 10px;
    overflow: hidden;
    font-size: 12px;
    font-weight: 400;
    background: transparent;
  }

  // 进度条：order 2 固定在信息区底部边缘线。
  .wub-track {
    order: 2;
    display: flex;
    overflow: hidden;
    height: 6px;
    flex: none;
    // 分割线本体：无数据时也可见一条细线。
    background: color-mix(in srgb, var(--nx-cyan) 18%, transparent);
    transition: height 160ms ease;
  }
  &:hover .wub-track {
    height: 10px;
  }

  .wub-seg {
    height: 100%;
    flex-shrink: 0;
    min-width: 8px;
    transition: width 0.3s ease;
  }
  .wub-fill {
    height: 100%;
    background: var(--wub-color);
    transition: width 0.3s ease;
  }

  // ── 内容排版：统一 12px，小字等宽数字 ──
  .wub-row {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 6px;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    white-space: nowrap;
    line-height: 17px;
  }
  .wub-main-row {
    flex: 0 0 auto;
    min-height: 18px;
  }
  .wub-main-row > :not(:first-child)::before,
  .wub-subagent > :not(:first-child)::before {
    content: '·';
    margin-right: 6px;
    color: color-mix(in srgb, var(--nx-text) 40%, transparent);
  }
  .wub-main-row > span,
  .wub-main-row > time,
  .wub-subagent > span,
  .wub-subagent > time {
    flex: none;
  }
  .wub-model,
  .wub-thinking,
  .wub-speed,
  .wub-elapsed {
    color: color-mix(in srgb, var(--nx-text) 76%, transparent);
  }
  .wub-values {
    color: var(--wub-color);
  }
  .wub-breakdown {
    flex: none;
  }
  .wub-breakdown.is-zero {
    opacity: 0.45;
  }
  .wub-subagents {
    flex: 0 0 auto;
    gap: 12px;
    overflow-x: hidden;
    overflow-y: hidden;
  }
  .wub-subagent {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 6px;
    color: color-mix(in srgb, var(--nx-text) 82%, transparent);
    white-space: nowrap;
  }
  .wub-thinking {
    color: var(--nx-cyan);
  }
  .wub-elapsed {
    margin-left: auto;
    color: color-mix(in srgb, var(--nx-text) 72%, transparent);
  }
  .wub-running {
    color: var(--wub-color);
  }
  .wub-speed {
    color: color-mix(in srgb, var(--nx-text) 72%, transparent);
  }
}
</style>
