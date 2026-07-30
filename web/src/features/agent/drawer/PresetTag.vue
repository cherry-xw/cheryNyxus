<script setup lang="ts">
/**
 * PresetTag：会话预设标签（暖橙系）。
 * cheryNyxus 预设显固定高亮 chip「Nexus」；其它预设显预设名；无 preset 则不渲染。
 * 供 NyxusHistoryPanel / SessionList / AgentDialog 复用，对齐 element-plus 暖橙主题（#f6b73c）。
 */
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'

defineProps<{ preset?: string }>()
</script>

<template>
  <span
    v-if="preset"
    class="preset-tag"
    :class="{ 'preset-tag-nyxus': preset === CHERY_NYXUS_PRESET }"
    :title="preset"
  >
    {{ preset === CHERY_NYXUS_PRESET ? 'Nexus' : preset }}
  </span>
</template>

<style scoped lang="less">
.preset-tag {
  display: inline-block;
  flex-shrink: 0;
  max-width: 88px;
  padding: 0 6px;
  border: 1px solid rgba(180, 110, 20, 0.35);
  border-radius: 4px;
  background: linear-gradient(135deg, rgba(255, 242, 195, 0.94), rgba(246, 183, 60, 0.18));
  color: #76500e;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
  vertical-align: baseline;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &.preset-tag-nyxus {
    border-color: rgba(180, 110, 20, 0.55);
    background: linear-gradient(135deg, #ffd27a, #f6b73c);
    color: #3d2606;
  }
}
</style>
