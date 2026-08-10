<script setup lang="ts">
/** LimitsCard：超时 / 上限矩阵 + 看门狗。ms↔秒换算集中在此 computed。 */
import { computed } from 'vue'
import type { GlobalConfigDto } from '@/services/agentApi'
import NeonNumberControl from '../../../controls/NeonNumberControl.vue'

const props = defineProps<{ global: GlobalConfigDto; no: number }>()

/**
 * 审批等待时长（global.approval_timeout）：后端存 ms，前端 UI 按秒录入。
 * - 读取：ms ÷ 1000 → 秒（undefined 时保持 undefined，placeholder 显示「0 = 不超时」）
 * - 写入：秒 × 1000 → ms；清空时回退到 undefined（不强制写 0，保留 yaml 原状）
 */
const approvalTimeoutSeconds = computed<number | undefined>({
  get: () => {
    const ms = props.global.approval_timeout
    return ms === undefined ? undefined : Math.round(ms / 1000)
  },
  set: (sec) => {
    if (sec === undefined || sec === null || Number.isNaN(sec)) {
      delete props.global.approval_timeout
    } else {
      props.global.approval_timeout = sec * 1000
    }
  },
})

/**
 * 看门狗超时（global.watchdog.timeout_ms）：后端存 ms（默认 300000=5min），前端 UI 按秒录入。
 * - 读取：ms ÷ 1000 → 秒（undefined 保持 undefined，placeholder 显「300」）
 * - 写入：秒 × 1000 → ms；清空时 delete key（保留 yaml 原状，由后端兜底 5min）
 */
const watchdogTimeoutSeconds = computed<number | undefined>({
  get: () => {
    const ms = props.global.watchdog?.timeout_ms
    return ms === undefined ? undefined : Math.round(ms / 1000)
  },
  set: (sec) => {
    const wd = props.global.watchdog
    if (!wd) return
    if (sec === undefined || sec === null || Number.isNaN(sec)) {
      delete wd.timeout_ms
    } else {
      wd.timeout_ms = sec * 1000
    }
  },
})
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span>LIMIT MATRIX
  </div>
  <div class="limit-grid">
    <NeonNumberControl
      v-model="global.sense_execute_timeout"
      label="工具执行超时"
      tip="超过此时间将进入后台执行"
      placeholder="30000"
      unit="ms"
      :step="5000"
      :min="0"
    />
    <NeonNumberControl
      v-model="approvalTimeoutSeconds"
      label="审批等待"
      tip="0 = 不限时；超时按拒绝处理"
      placeholder="不限时"
      unit="秒"
      :step="10"
      :min="0"
    />
    <NeonNumberControl
      v-model="global.maxLoopCount"
      label="工具调用上限"
      tip="单轮可连续调用工具的次数"
      placeholder="30"
      :step="5"
      :min="1"
    />
    <NeonNumberControl
      v-model="global.bash_log_retention_hours"
      label="命令日志保留"
      tip="只清理 execute_command 日志"
      placeholder="24"
      unit="小时"
      :step="6"
      :min="0"
    />
    <NeonNumberControl
      v-model="global.tree_full_render_threshold"
      label="节点树全量渲染阈值"
      tip="节点数≤此值跳过视口裁剪，消除平移卡顿；0 = 始终裁剪"
      placeholder="500"
      :step="50"
      :min="0"
    />
  </div>
  <div v-if="global.watchdog" class="watchdog-row">
    <NeonNumberControl
      v-model="watchdogTimeoutSeconds"
      label="看门狗超时"
      tip="子 agent 无产出超过此时间判定卡死（每次产出重置计时）"
      placeholder="300"
      unit="秒"
      :step="30"
      :min="0"
    />
    <button
      type="button"
      class="stream-chip"
      :class="{ active: global.watchdog.wake_on_timeout === true }"
      :aria-pressed="global.watchdog.wake_on_timeout === true"
      :title="
        global.watchdog.wake_on_timeout
          ? '超时将通知主 agent'
          : '超时仅暂停子 agent（主不受影响）'
      "
      @click="global.watchdog.wake_on_timeout = !global.watchdog.wake_on_timeout"
    >
      <span>⏰</span><b>超时唤主</b><small>{{
        global.watchdog.wake_on_timeout ? '通知主' : '仅暂停子'
      }}</small>
    </button>
  </div>
</template>

<style scoped lang="less">
@import './shared-neon.less';

.limit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
// 看门狗组：NeonNumberControl + stream-chip 横排，与 limit-grid 底部对齐
.watchdog-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin-top: 4px;
}
.watchdog-row > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.watchdog-row .stream-chip {
  flex: 0 0 auto;
}

@media (max-width: 760px) {
  .limit-grid {
    grid-template-columns: 1fr;
  }
}
</style>
