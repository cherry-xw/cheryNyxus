<script setup lang="ts">
import type { InputSuggestion } from './useInstructionSuggestions'
import { nextTick, ref, watch } from 'vue'
const props = defineProps<{
  items: InputSuggestion[]
  activeIndex: number
  message: string
  opened: boolean
}>()
const emit = defineEmits<{ select: [item: InputSuggestion] }>()
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
    aria-label="指令、角色和文件候选"
  >
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
