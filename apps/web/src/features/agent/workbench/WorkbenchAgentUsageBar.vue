<script setup lang="ts">
/**
 * 工作台底部 Agent 用量条：默认占据底部空间并以两行小字展示详情。
 *
 * - divider（树 / 对话）：主 Agent 一行、子 Agent 一行。
 * - lite（精简视图）：紧凑摘要——主 Agent 名称后显示任务总时长，再列 used/total/占比、运行状态与 token 速度 +
 *   子 Agent 计数（内容精简初版，后续按精简模式 API 特性再细化）。
 *
 * 进度条固定在信息区最底部，详情默认展示。
 */
import { computed } from 'vue'
import { breakdownSegments, fmtTokens } from '../toolbar/contextBreakdown'
import { usageClass } from './useWorkbenchContextInspector'
import type { WorkbenchAgentUsageView } from './useWorkbenchAgentUsage'
import { durationColor, readableDuration } from '@/domain/chat/executionDuration'

const props = withDefaults(
  defineProps<{
    /** 全部 Agent 用量视图（主 Agent 恒在首位）。 */
    agents: WorkbenchAgentUsageView[]
    /** 采集 token 速度（tok/s）。 */
    tokenSpeed: number
    /** divider=树/对话完整档；lite=精简档。 */
    variant?: 'divider' | 'lite'
    taskElapsedMs?: number
    canStop?: boolean
    stopping?: boolean
  }>(),
  { variant: 'divider' },
)
const emit = defineEmits<{ stop: [] }>()

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
        <div class="wub-main-line">
        <div class="wub-row wub-main-row">
          <span>{{ rootAgent.label }}</span>
          <time v-if="taskElapsedMs !== undefined" class="wub-duration"
            :style="{ color: durationColor(taskElapsedMs, 600000, 1800000) }"
            :aria-label="`本次任务总运行时长 ${readableDuration(taskElapsedMs)}`"
          >{{ readableDuration(taskElapsedMs) }}</time>
          <span v-if="rootAgent.model" class="wub-model">{{ rootAgent.model }}</span>
          <span v-if="rootAgent.thinkingLabel" class="wub-thinking"
            >思考 {{ rootAgent.thinkingLabel }}</span
          >
          <span v-if="rootAgent.running" class="wub-running">运行中</span>
          <span v-if="tokenSpeed > 0" class="wub-speed">{{ fmtSpeed(tokenSpeed) }} tok/s</span>
          <span v-if="hasValues" class="wub-values"
            >{{ fmtTokens(usedTokens) }}/{{ fmtTokens(totalTokens) }} {{ pct }}%</span
          >
          <span
            v-for="seg in allSegs"
            :key="seg.key"
            class="wub-breakdown"
            :class="[`label-${seg.key}`, { 'is-zero': seg.tokens === 0 }]"
          >
            {{ seg.label }} {{ fmtTokens(seg.tokens) }}
          </span>
        </div>
        <div class="wub-actions">
          <button v-if="canStop" type="button" class="wub-stop" :disabled="stopping"
            :aria-label="stopping ? '正在停止全部分支' : '停止整个任务（全部分支）'" @click="emit('stop')"
          >{{ stopping ? '停止中…' : '■ 停止全部' }}</button>
        </div>
        </div>
        <div v-if="subAgents.length" class="wub-row wub-subagents">
          <div v-for="sub in subAgents" :key="sub.chatId" class="wub-subagent">
            <span>{{ sub.label }}</span>
            <time v-if="sub.running || sub.elapsedMs > 0" class="wub-duration"
              :style="{ color: durationColor(sub.elapsedMs, 600000, 1800000) }"
              :aria-label="`${sub.label} 总运行时长 ${readableDuration(sub.elapsedMs)}`"
            >{{ readableDuration(sub.elapsedMs) }}</time>
            <span>{{ subTokensText(sub) }}</span>
            <span v-if="sub.running" class="wub-running">运行中</span>
          </div>
        </div>
      </template>
      <!-- 精简档（精简视图）：紧凑摘要 -->
      <template v-else-if="variant === 'lite' && rootAgent">
        <div class="wub-main-line">
        <div class="wub-row wub-main-row">
          <span>{{ rootAgent.label }}</span>
          <time v-if="taskElapsedMs !== undefined" class="wub-duration"
            :style="{ color: durationColor(taskElapsedMs, 600000, 1800000) }"
            :aria-label="`本次任务总运行时长 ${readableDuration(taskElapsedMs)}`"
          >{{ readableDuration(taskElapsedMs) }}</time>
          <span v-if="rootAgent.model" class="wub-model">{{ rootAgent.model }}</span>
          <span v-if="rootAgent.thinkingLabel" class="wub-thinking"
            >思考 {{ rootAgent.thinkingLabel }}</span
          >
          <span v-if="rootAgent.running" class="wub-running">运行中</span>
          <span v-if="hasValues" class="wub-values"
            >{{ fmtTokens(usedTokens) }}/{{ fmtTokens(totalTokens) }} {{ pct }}%</span
          >
          <span v-if="tokenSpeed > 0" class="wub-speed">{{ fmtSpeed(tokenSpeed) }} tok/s</span>
        </div>
        <div class="wub-actions">
          <button v-if="canStop" type="button" class="wub-stop" :disabled="stopping"
            :aria-label="stopping ? '正在停止全部分支' : '停止整个任务（全部分支）'" @click="emit('stop')"
          >{{ stopping ? '停止中…' : '■ 停止全部' }}</button>
        </div>
        </div>
        <div v-if="subAgents.length" class="wub-row wub-subagents">
          <div v-for="sub in subAgents" :key="sub.chatId" class="wub-subagent">
            <span>{{ sub.label }}</span>
            <time v-if="sub.running || sub.elapsedMs > 0" class="wub-duration"
              :style="{ color: durationColor(sub.elapsedMs, 600000, 1800000) }"
              :aria-label="`${sub.label} 总运行时长 ${readableDuration(sub.elapsedMs)}`"
            >{{ readableDuration(sub.elapsedMs) }}</time>
            <span>{{ subTokensText(sub) }}</span>
            <span v-if="sub.running" class="wub-running">运行中</span>
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
  .wub-main-line { display: flex; align-items: center; min-width: 0; width: 100%; flex: none; }
  .wub-actions { display: flex; align-items: center; gap: 8px; flex: none; margin-left: auto; padding-left: 10px; background: var(--surface); }
  .wub-duration { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .wub-stop { border: 1px solid #ef4444; background: color-mix(in srgb, #ef4444 15%, var(--surface)); color: #ef4444; cursor: pointer; font: inherit; padding: 0 5px; white-space: nowrap; }
  .wub-stop:hover { background: #ef4444; color: #fff; }
  .wub-stop:disabled { opacity: .55; cursor: wait; }

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
    flex: 1 1 auto;
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
  // 分解段文字色（与 BREAKDOWN_SEGMENTS 类别色一致；深色提亮见文件末尾无 scoped 块）。
  .wub-breakdown.label-system {
    color: #6366f1;
  }
  .wub-breakdown.label-userSystem {
    color: #a855f7;
  }
  .wub-breakdown.label-memory {
    color: #ec4899;
  }
  .wub-breakdown.label-skills {
    color: #f59e0b;
  }
  .wub-breakdown.label-tools {
    color: #10b981;
  }
  .wub-breakdown.label-conversation {
    color: #3b82f6;
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
  .wub-running {
    color: var(--wub-color);
  }
  .wub-speed {
    color: color-mix(in srgb, var(--nx-text) 72%, transparent);
  }
}
</style>

<!-- 深色模式提亮（无 scoped 块，仅提亮前景文字）：分解段文字不再用内联 seg.color
（内联样式无法被 CSS 覆盖，是此前深色下蓝/紫文字对比度低的根因），改走类名提亮。 -->
<style lang="less">
[data-theme='dark'] .wub-bar .wub-breakdown.label-system {
  color: #a5b4fc;
}
[data-theme='dark'] .wub-bar .wub-breakdown.label-userSystem {
  color: #d8b4fe;
}
[data-theme='dark'] .wub-bar .wub-breakdown.label-memory {
  color: #f9a8d4;
}
[data-theme='dark'] .wub-bar .wub-breakdown.label-skills {
  color: #fcd34d;
}
[data-theme='dark'] .wub-bar .wub-breakdown.label-tools {
  color: #34d399;
}
[data-theme='dark'] .wub-bar .wub-breakdown.label-conversation {
  color: #93c5fd;
}
</style>
