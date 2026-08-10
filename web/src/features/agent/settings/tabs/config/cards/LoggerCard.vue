<script setup lang="ts">
/** LoggerCard：应用日志等级 / 格式 / 输出信号开关。 */
import type { GlobalConfigDto } from '@/services/agentApi'

type LoggerCfg = NonNullable<GlobalConfigDto['logger']>

const props = defineProps<{ logger: LoggerCfg; no: number }>()

function toggleLoggerOutput(value: 'console' | 'file'): void {
  const current = props.logger.output ?? []
  props.logger.output = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value]
}
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span>TRACE CONSOLE
  </div>
  <h3 class="sub-title">应用日志</h3>
  <div class="logger-console">
    <div>
      <span>等级</span>
      <div class="segment-deck">
        <button
          v-for="level in ['debug', 'info', 'warn', 'error', 'silent'] as const"
          :key="level"
          type="button"
          :class="{ active: logger.level === level }"
          @click="logger.level = level"
        >
          {{ level }}
        </button>
      </div>
    </div>
    <div>
      <span>格式</span>
      <div class="segment-deck">
        <button
          v-for="format in ['plain', 'json'] as const"
          :key="format"
          type="button"
          :class="{ active: logger.format === format }"
          @click="logger.format = format"
        >
          {{ format }}
        </button>
      </div>
    </div>
    <div>
      <span>信号</span>
      <div class="signal-deck">
        <button
          type="button"
          :class="{ active: logger.output?.includes('console') }"
          @click="toggleLoggerOutput('console')"
        >
          终端</button
        ><button
          type="button"
          :class="{ active: logger.output?.includes('file') }"
          @click="toggleLoggerOutput('file')"
        >
          文件</button
        ><button
          type="button"
          :class="{ active: logger.timestamp }"
          @click="logger.timestamp = !logger.timestamp"
        >
          时间</button
        ><button
          type="button"
          :class="{ active: logger.location }"
          @click="logger.location = !logger.location"
        >
          位置
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './shared-neon.less';

.logger-console {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.logger-console > div {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  align-items: center;
  gap: 5px;
}
.logger-console > div > span {
  font-size: 9px;
  font-weight: 800;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}
</style>
