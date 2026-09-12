<script setup lang="ts">
import { boardPath, boardTitle } from './headerLayout'
import type { HeaderTerminalEvent } from './headerGraph'
defineProps<{ board: string; relation?: HeaderTerminalEvent }>()
const emit = defineEmits<{
  navigate: [board: string]
  back: []
  closeRelation: []
  traceEnd: [end: 'source' | 'target']
}>()
</script>

<template>
  <div class="workflow-board-navigation nodrag nopan nowheel" @pointerdown.stop @wheel.stop>
    <nav aria-label="芯片封装路径">
      <button v-if="board !== 'overview'" type="button" data-board-back @click="emit('back')">
        返回上层
      </button>
      <template v-for="(id, index) in boardPath(board)" :key="id">
        <span v-if="index" aria-hidden="true">/</span>
        <button
          type="button"
          :aria-current="id === board ? 'location' : undefined"
          @click="emit('navigate', id)"
        >
          {{ boardTitle(id) }}
        </button>
      </template>
    </nav>
    <p>芯片封装内部电路。点击「进入内部」或在芯片上放大；P 编号是接口，点击可追踪来源与去向。</p>
    <section
      v-if="relation"
      class="workflow-board-relation"
      aria-label="接口关系详情"
      aria-live="polite"
    >
      <span>{{ relation.terminal.code }} · {{ relation.terminal.label }}</span>
      <button type="button" @click="emit('traceEnd', 'source')">定位来源</button>
      <button type="button" @click="emit('traceEnd', 'target')">定位去向</button>
      <button type="button" @click="emit('closeRelation')">关闭接口详情</button>
    </section>
  </div>
</template>

<style scoped lang="less">
.workflow-board-navigation {
  flex: none;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--ink);
  background: var(--panel);
  font-size: 12px;
  font-weight: 400;
}
nav,
.workflow-board-relation {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
p {
  margin: 6px 0 0;
  line-height: 1.5;
}
button {
  min-height: 32px;
  padding: 4px 8px;
  font: inherit;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
}
button[aria-current],
button:hover {
  border-color: var(--accent);
  color: var(--accent);
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.workflow-board-relation {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
</style>
