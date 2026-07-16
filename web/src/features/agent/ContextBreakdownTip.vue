<script setup lang="ts">
/**
 * ContextBreakdownTip：上下文用量 6 段明细（el-tooltip content 用）。
 * 每段：色块·标签·(条数)·tokens·占比。scoped 样式随组件实例生效（popper 内仍生效）。
 */
import type { ContextBreakdown } from "@/services/agentApi";
import { breakdownSegments, fmtTokens, segmentCountText } from "./contextBreakdown";

defineProps<{ breakdown?: ContextBreakdown }>();
</script>

<template>
  <div v-if="breakdown" class="ctx-tip">
    <div
      v-for="seg in breakdownSegments(breakdown)"
      :key="seg.key"
      class="ctx-tip-row"
      :class="{ 'is-zero': seg.tokens === 0 }"
    >
      <span class="ctx-dot" :style="{ background: seg.color }" />
      <span class="ctx-tip-label">{{ seg.label }}</span>
      <span v-if="segmentCountText(seg)" class="ctx-tip-count">{{ segmentCountText(seg) }}</span>
      <span class="ctx-tip-val">{{ fmtTokens(seg.tokens) }}</span>
      <span class="ctx-tip-pct">{{ seg.pct }}%</span>
    </div>
  </div>
</template>

<style scoped lang="less">
.ctx-tip {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 168px;
}
.ctx-tip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
}
.ctx-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}
.ctx-tip-label {
  flex: 1;
}
.ctx-tip-count {
  font-size: 10px;
  opacity: 0.6;
}
.ctx-tip-val {
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.ctx-tip-pct {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  min-width: 34px;
  text-align: right;
}
.ctx-tip-row.is-zero {
  opacity: 0.4;
}
</style>
