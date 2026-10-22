<script setup lang="ts">
/** MemoryCard：记忆上限。scope='global' 跨 chat 共享 / 'workspace' per 项目；复用同一结构。 */
import { computed } from 'vue'
import type { ConfigDto } from '@/application/backend/public'
import NeonNumberControl from '../../../controls/NeonNumberControl.vue'
import { optionalDraftSection } from '../../../model/optionalDraftSection'
import { DEFAULT_MEMORY_CONFIG } from '@chery/protocol'

type MemoryCfg = NonNullable<ConfigDto['memory']>
type Scope = 'global' | 'workspace'

const props = defineProps<{ scope: Scope; memory: MemoryCfg; no: number }>()

const isGlobal = computed(() => props.scope === 'global')

const scopeCfg = optionalDraftSection(() => props.memory[props.scope], value => {
  if (value === undefined) delete props.memory[props.scope]
  else props.memory[props.scope] = value
})
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span
    >{{ isGlobal ? 'SHARED MEMORY' : 'LOCAL MEMORY' }}
  </div>
  <h3 class="sub-title">
    {{ isGlobal ? '全局记忆（所有 chat 共享）' : 'Workspace 记忆（per 项目 / 单 chat）' }}
  </h3>
  <p class="block-summary">
    <code>{{ scope }}</code> · {{ isGlobal ? '跨会话共享' : '项目隔离' }} · 超限自动归档
  </p>
  <div class="neon-grid">
    <NeonNumberControl
      v-model="scopeCfg.max_count"
      label="活跃条数"
      :tip="isGlobal ? '跨 chat 共享的活跃记忆上限' : '当前项目的活跃记忆上限'"
      :default-value="DEFAULT_MEMORY_CONFIG[scope].max_count"
      unit="条"
      :step="5"
      :min="1"
    />
    <NeonNumberControl
      v-model="scopeCfg.max_chars"
      label="单条字数"
      tip="单条正文软性字数建议"
      :default-value="DEFAULT_MEMORY_CONFIG[scope].max_chars"
      unit="字"
      :step="100"
      :min="1"
    />
  </div>
</template>

<style scoped lang="less">
@import './shared-neon.less';
</style>
