<script setup lang="ts">
import type {
  InputSuggestion,
  InstructionTabId,
  InstructionTabOption,
} from './useInstructionSuggestions'
import { nextTick, ref, watch } from 'vue'
const props = defineProps<{
  items: InputSuggestion[]
  activeIndex: number
  message: string
  opened: boolean
  /** 斜杠指令菜单的 tab 栏数据（指令/技能/组合技）；非 / 触发时为空数组，不显示 tab 栏。 */
  tabs: InstructionTabOption[]
  activeTab: InstructionTabId
}>()
const emit = defineEmits<{
  select: [item: InputSuggestion]
  selectTab: [tab: InstructionTabId]
}>()
const list = ref<HTMLElement | null>(null)
watch(
  () => props.activeIndex,
  () =>
    void nextTick(() =>
      list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }),
    ),
)
</script>
<template>
  <div
    v-if="opened"
    ref="list"
    class="instruction-suggestions"
    role="listbox"
    :aria-label="tabs.length ? '指令、技能和组合技候选' : '指令、角色和文件候选'"
  >
    <div v-if="tabs.length" class="instruction-tabs" role="tablist" aria-label="指令类型">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="instruction-tab"
        :class="{ 'is-active': tab.id === activeTab }"
        :disabled="tab.count === 0"
        role="tab"
        :aria-selected="tab.id === activeTab"
        @mousedown.prevent
        @click="emit('selectTab', tab.id)"
      >
        {{ tab.label }}<span class="instruction-tab-count">{{ tab.count }}</span>
      </button>
    </div>
    <button
      v-for="(item, index) in items"
      :key="item.token"
      type="button"
      role="option"
      :aria-selected="index === activeIndex"
      :class="{ active: index === activeIndex }"
      @mousedown.prevent
      @click="emit('select', item)"
    >
      <span>{{ item.label }}</span
      ><small>{{ item.description }}</small>
    </button>
    <p v-if="message" role="status">{{ message }}</p>
  </div>
</template>
<style scoped>
.instruction-suggestions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 3;
  display: flex;
  flex-direction: column;
  max-height: 240px;
  overflow: auto;
  background: var(--nx-bg, var(--el-bg-color));
  color: var(--nx-text, var(--el-text-color-primary));
  border: 1px solid var(--el-border-color);
}
.instruction-tabs {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  gap: 2px;
  padding: 4px 4px 2px;
  border-bottom: 1px solid var(--el-border-color);
  background: inherit;
}
.instruction-tab {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
}
.instruction-tab:hover:not(:disabled),
.instruction-tab.is-active {
  background: var(--el-fill-color);
  color: var(--el-color-primary);
}
.instruction-tab:disabled {
  cursor: default;
  opacity: 0.42;
}
.instruction-tab-count {
  min-width: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--el-fill-color);
  color: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 14px;
  text-align: center;
}
button {
  font: inherit;
  font-size: 14px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  border: 0;
  padding: 8px 12px;
  text-align: left;
  background: transparent;
  color: inherit;
  font-weight: 400;
  cursor: pointer;
  overflow-wrap: anywhere;
}
button.active,
button:hover {
  background: var(--el-fill-color);
}
small,
p {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 400;
}
p {
  padding: 8px 12px;
  margin: 0;
}
</style>
