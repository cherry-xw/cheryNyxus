<script setup lang="ts">
/** LimitsCard：超时 / 上限矩阵 + 看门狗。ms↔秒换算集中在此 computed。 */
import { computed } from 'vue'
import type { GlobalConfigDto } from '@/application/backend/public'
import NeonNumberControl from '../../../controls/NeonNumberControl.vue'
import { DEFAULT_GLOBAL_OPTIONS } from '@chery/protocol'
import { optionalDraftSection } from '../../../model/optionalDraftSection'

const props = defineProps<{ global: GlobalConfigDto; no: number }>()
const defaults = DEFAULT_GLOBAL_OPTIONS
const watchdog = optionalDraftSection(() => props.global.watchdog, value => {
  if (value === undefined) delete props.global.watchdog
  else props.global.watchdog = value
})

const modelTimeoutMinutes = computed<number | undefined>({
  get: () => props.global.llm_request_timeout_ms === undefined
    ? undefined
    : props.global.llm_request_timeout_ms / 60000,
  set: (minutes) => {
    if (minutes === undefined || minutes === null) {
      delete props.global.llm_request_timeout_ms
    } else {
      props.global.llm_request_timeout_ms = minutes * 60000
    }
  },
})

/**
 * 审批等待时长（global.approval_timeout）：后端存 ms，前端 UI 按秒录入。
 * - 读取：ms ÷ 1000 → 秒（undefined 时保持 undefined，placeholder 显示默认 300 秒）
 * - 写入：秒 × 1000 → ms；清空时回退到 undefined（不强制写 0，保留 yaml 原状）
 */
const approvalTimeoutSeconds = computed<number | undefined>({
  get: () => {
    const ms = props.global.approval_timeout
    return ms === undefined ? undefined : ms / 1000
  },
  set: (sec) => {
    if (sec === undefined || sec === null) {
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
    return ms === undefined ? undefined : ms / 1000
  },
  set: (sec) => {
    const wd = watchdog
    if (sec === undefined || sec === null) {
      delete wd.timeout_ms
    } else {
      wd.timeout_ms = sec * 1000
    }
  },
})
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span
    >LIMIT MATRIX
  </div>
  <div class="limit-grid">
    <NeonNumberControl
      v-model="modelTimeoutMinutes"
      label="单次模型请求超时"
      tip="从本次模型请求开始计时，持续收到内容也不会重置。默认 10 分钟；0 = 不限时。到时截断，已收到内容可查看，但不会加入后续模型上下文；工具和审批等待不计入。"
      :default-value="defaults.llm_request_timeout_ms / 60000"
      :integer="false"
      unit="分钟"
      :step="1"
      :min="0"
    />
    <NeonNumberControl
      v-model="global.sense_execute_timeout"
      label="工具执行超时"
      tip="超过此时间将进入后台执行"
      :default-value="defaults.sense_execute_timeout"
      :integer="false"
      unit="ms"
      :step="5000"
      :min="0"
    />
    <NeonNumberControl
      v-model="approvalTimeoutSeconds"
      label="审批等待"
      tip="默认 300 秒；0 = 不设置截止时间；到期拒绝该工具，Agent 继续执行；用户提问不受影响"
      :default-value="defaults.approval_timeout / 1000"
      :integer="false"
      unit="秒"
      :step="10"
      :min="0"
    />
    <NeonNumberControl
      v-model="global.maxLoopCount"
      label="工具调用上限"
      tip="单轮可连续调用工具的次数"
      :default-value="defaults.maxLoopCount"
      :step="5"
      :min="1"
    />
    <NeonNumberControl
      v-model="global.tree_full_render_threshold"
      label="节点树全量渲染阈值"
      tip="节点数不大于基础阈值时跳过视口裁剪；默认 150，卡牌模式最多 120；0 = 始终裁剪"
      :default-value="defaults.tree_full_render_threshold"
      :step="50"
      :min="0"
    />
  </div>
  <div class="watchdog-row">
    <NeonNumberControl
      v-model="watchdogTimeoutSeconds"
      label="看门狗超时"
      tip="子 agent 无产出超过此时间判定卡死（每次产出重置计时）"
      :default-value="defaults.watchdog.timeout_ms / 1000"
      :integer="false"
      unit="秒"
      :step="30"
      :min="0"
    />
    <button
      type="button"
      class="stream-chip"
      :class="{ active: watchdog.wake_on_timeout ?? defaults.watchdog.wake_on_timeout }"
      :aria-pressed="watchdog.wake_on_timeout ?? defaults.watchdog.wake_on_timeout"
      :title="
        watchdog.wake_on_timeout ? '超时将通知主 agent' : '超时仅暂停子 agent（主不受影响）'
      "
      @click="watchdog.wake_on_timeout = !(watchdog.wake_on_timeout ?? defaults.watchdog.wake_on_timeout)"
    >
      <span>⏰</span><b>超时唤主</b
      ><small>{{ watchdog.wake_on_timeout ? '通知主' : '仅暂停子' }}</small>
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
