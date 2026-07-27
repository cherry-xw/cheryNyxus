<script setup lang="ts">
/** MemoryCard：记忆上限。scope='global' 跨 chat 共享 / 'workspace' per 项目；复用同一结构。 */
import { computed } from 'vue'
import type { ConfigDto } from '@/services/agentApi'
import NeonNumberControl from '../../../controls/NeonNumberControl.vue'

type MemoryCfg = NonNullable<ConfigDto['memory']>
type Scope = 'global' | 'workspace'

const props = defineProps<{ scope: Scope; memory: MemoryCfg; no: number }>()

const isGlobal = computed(() => props.scope === 'global')

// GlobalTab watch 保证 memory[scope] 已初始化为 {}（非 undefined）；?? {} 仅为 TS 收窄类型。
const scopeCfg = computed(() => props.memory[props.scope] ?? {})
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span>{{ isGlobal ? 'SHARED MEMORY' : 'LOCAL MEMORY' }}
  </div>
  <h3 class="sub-title">{{
    isGlobal ? '全局记忆（所有 chat 共享）' : 'Workspace 记忆（per 项目 / 单 chat）'
  }}</h3>
  <p class="block-summary">
    <code>{{ scope }}</code> · {{ isGlobal ? '跨会话共享' : '项目隔离' }} · 超限自动归档
  </p>
  <div class="neon-grid">
    <NeonNumberControl
      v-model="scopeCfg.max_count"
      label="活跃条数"
      :tip="isGlobal ? '跨 chat 共享的活跃记忆上限' : '当前项目的活跃记忆上限'"
      :placeholder="isGlobal ? '30' : '15'"
      unit="条"
      :step="5"
      :min="1"
    />
    <NeonNumberControl
      v-model="scopeCfg.max_chars"
      label="单条字数"
      tip="单条正文软性字数建议"
      placeholder="500"
      unit="字"
      :step="100"
      :min="1"
    />
  </div>
</template>

<style scoped lang="less">
@import './shared-neon.less';
</style>
