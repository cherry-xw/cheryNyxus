<script setup lang="ts">
/**
 * RunningTools：运行中工具 icon 组（pet meta-row 右侧，PetToolbar 之后）。
 * 数据源：stream.runningTools（sense_started push / accept 按 id 移除 / done 清空）。
 * icon：agents.iconForTool(name) 查 sense.tools 缓存，未命中 fallback ⚙。
 * 多工具并发并排；暖橙底 + 脉冲动画区分运行态（与 PetToolbar compact 同色系）。
 */
import type { RunningTool } from "@/stores/agents";
import { useAgentsStore } from "@/stores";

const props = defineProps<{ tools: RunningTool[] }>();
const agents = useAgentsStore();
</script>

<template>
  <div v-if="props.tools.length" class="running-tools" aria-label="运行中工具">
    <span
      v-for="t in props.tools"
      :key="t.id"
      class="run-icon"
      :title="t.name"
    >{{ agents.iconForTool(t.name) }}</span>
  </div>
</template>

<style scoped lang="less">
@glyph-fonts: ui-rounded, "Hiragino Sans", "PingFang SC", "Noto Sans Symbols 2",
  "Noto Sans Symbols", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif;

.running-tools {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.run-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 5px;
  background: rgba(255, 196, 87, 0.4);
  font-family: @glyph-fonts;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  animation: run-pulse 1.1s ease-in-out infinite;
}

@keyframes run-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
</style>
