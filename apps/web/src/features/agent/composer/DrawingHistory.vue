<script setup lang="ts">
import DrawingTaskList from './DrawingTaskList.vue'
import { useDrawingRecords } from './useDrawingRecords'
const props = defineProps<{ chatId: string }>()
const { tasks, error, busy, refresh } = useDrawingRecords(() => props.chatId)
</script>
<template>
  <details v-if="tasks.length || error" class="drawing-history" :aria-busy="busy">
    <summary>绘图轮次与用户定稿（{{ tasks.length }} 个任务）</summary>
    <button type="button" :disabled="busy" @click="refresh">刷新记录（不生成）</button>
    <DrawingTaskList :tasks="tasks" />
    <p v-if="error" role="alert">{{ error }}</p>
  </details>
</template>
<style scoped>
.drawing-history { padding:10px; max-height:50vh; overflow:auto; font-size:14px; line-height:1.5; } button { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-strong); padding:7px; } p { overflow-wrap:anywhere; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
