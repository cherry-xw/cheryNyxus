<script setup lang="ts">
/**
 * LiteTodoPanel：update_todo 专有内容区（精简模式详情抽屉工具链内使用）。
 * 只渲染待办内容区——工具名/简介/风险徽章等头部由 LiteToolCallDetail 统一提供。
 * 从本次调用的 arguments.todos 解析完整待办列表，按状态渲染 ☐ / ▣ / ✓（pending / in_progress / completed）。
 * 解析失败时留空（外层通用渲染不介入，避免重复）；层级保持扁平，不套边框背景。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import type { TodoItem } from '@/features/agent/renderers/types'
import { parseJsonValue } from './toolRendering'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const todos = computed<TodoItem[]>(() => {
  const value = parseJsonValue(props.call.arguments)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const list = (value as Record<string, unknown>).todos
  if (!Array.isArray(list)) return []
  return list.filter(
    (item): item is TodoItem =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as TodoItem).content === 'string' &&
      typeof (item as TodoItem).status === 'string',
  )
})
const doneCount = computed(() => todos.value.filter((t) => t.status === 'completed').length)
const statusGlyph = (s: TodoItem['status']): string =>
  s === 'completed' ? '✓' : s === 'in_progress' ? '▣' : '☐'
</script>

<template>
  <div v-if="todos.length" class="lite-todo">
    <div class="lite-todo-head">
      <span class="lite-todo-title">待办</span>
      <span class="lite-todo-count">{{ doneCount }}/{{ todos.length }} 完成</span>
    </div>
    <ul class="lite-todo-list">
      <li v-for="(t, i) in todos" :key="i" class="lite-todo-item" :class="`is-${t.status}`">
        <span class="lite-todo-glyph" aria-hidden="true">{{ statusGlyph(t.status) }}</span>
        <span class="lite-todo-copy">
          <span class="lite-todo-text" :class="{ done: t.status === 'completed' }">{{
            t.content
          }}</span>
          <small v-if="t.activeForm" class="lite-todo-form">{{ t.activeForm }}</small>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* 待办内容区：扁平列表，不套边框/背景（层级保持扁平）。 */
.lite-todo {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.lite-todo-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.lite-todo-title {
  color: var(--el-text-color-primary);
  font-size: 15px;
  font-weight: 400;
}
.lite-todo-count {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.lite-todo-list {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.lite-todo-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: start;
  gap: 6px;
  min-width: 0;
}
.lite-todo-glyph {
  margin-top: 1px;
  width: 16px;
  color: var(--el-text-color-placeholder);
  font-size: 15px;
  line-height: 1.5;
  text-align: center;
}
.lite-todo-item.is-in_progress .lite-todo-glyph {
  color: var(--el-color-warning);
}
.lite-todo-item.is-completed .lite-todo-glyph {
  color: var(--el-color-success);
}
.lite-todo-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.lite-todo-text {
  color: var(--el-text-color-primary);
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.lite-todo-text.done {
  color: var(--el-text-color-placeholder);
  text-decoration: line-through;
}
.lite-todo-form {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
