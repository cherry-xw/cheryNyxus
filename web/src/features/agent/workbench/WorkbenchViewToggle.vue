<script setup lang="ts">
import { useWorkbenchViewMode } from './useWorkbenchViewMode'
import type { WorkbenchViewMode } from '@/features/lite/liteStore'

const props = defineProps<{ windowId: string }>()
const { viewMode, setViewMode } = useWorkbenchViewMode(props.windowId)

// 三档视图：树（节点树主画布）/ 对话（整屏会话气泡视图）/ 精简（lite 紧凑会话视图）。
// 精简是对话的紧凑展示方式，二者同属会话展示家族，与树视图互斥。
const MODES: Array<{ key: WorkbenchViewMode; icon: string; label: string }> = [
  { key: 'tree', icon: '⌘', label: '树' },
  { key: 'conversation', icon: '↺', label: '对话' },
  { key: 'lite', icon: '▤', label: '精简' },
]
</script>

<template>
  <div class="workbench-view-toggle" data-window-interactive role="group" aria-label="工作台视图">
    <button
      v-for="mode in MODES"
      :key="mode.key"
      type="button"
      :class="{ active: viewMode === mode.key }"
      :aria-pressed="viewMode === mode.key"
      @click="setViewMode(mode.key)"
    >
      <i aria-hidden="true">{{ mode.icon }}</i><span>{{ mode.label }}</span>
    </button>
  </div>
</template>

<style scoped lang="less">
.workbench-view-toggle {
  display: inline-flex;
  height: 26px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--cyber-line));
  background: color-mix(in srgb, var(--cyber-title-bg) 88%, transparent);
  box-shadow: inset 0 0 12px color-mix(in srgb, var(--accent) 8%, transparent);
}

button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 46px;
  padding: 0 7px;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
  font: 600 8px/1 var(--font-mono);
  letter-spacing: 0.1em;
  cursor: pointer;
}

button i {
  color: var(--accent);
  font-style: normal;
  font-size: 10px;
}

button.active {
  background: var(--accent);
  color: var(--accent-ink);
  box-shadow: 0 0 12px var(--accent-glow);
}

button.active i {
  color: inherit;
}

@media (max-width: 760px) {
  button {
    min-width: 28px;
  }
  button span {
    display: none;
  }
}
</style>
