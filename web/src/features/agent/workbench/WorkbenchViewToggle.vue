<script setup lang="ts">
import { useLiteViewToggle } from './useLiteViewToggle'

const props = defineProps<{ windowId: string }>()
const { liteViewEnabled, toggleLiteView } = useLiteViewToggle(props.windowId)
</script>

<template>
  <div class="workbench-view-toggle" data-window-interactive role="group" aria-label="工作台视图">
    <button
      type="button"
      :class="{ active: !liteViewEnabled }"
      :aria-pressed="!liteViewEnabled"
      @click="liteViewEnabled && toggleLiteView()"
    >
      <i aria-hidden="true">⌘</i><span>树</span>
    </button>
    <button
      type="button"
      :class="{ active: liteViewEnabled }"
      :aria-pressed="liteViewEnabled"
      @click="!liteViewEnabled && toggleLiteView()"
    >
      <i aria-hidden="true">▤</i><span>精简</span>
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
  min-width: 58px;
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
