<script setup lang="ts">
/**
 * TodoSenseBox：update_todo 专用渲染（替换通用 SenseCallBox 的 JSON 平铺）。
 * 读 call.args（后端契约 JSON 字符串 {todos:[{content,status,activeForm}]}）→ checklist。
 * status：pending ☐ / in_progress ▣（+ activeForm 副标题）/ completed ✓（strikethrough）。
 * 解析失败 → fallback 显原文 JSON pre（规则12：不静默吞错，warn 留 console）。
 */
import { computed } from "vue";
import type { SenseCallRecord } from "@/stores/agents";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

const props = defineProps<{ call: SenseCallRecord }>();

const parsed = computed<{ todos: TodoItem[] } | null>(() => {
  try {
    const raw = typeof props.call.args === "string" ? props.call.args : JSON.stringify(props.call.args ?? {});
    const obj = JSON.parse(raw) as { todos?: TodoItem[] };
    if (Array.isArray(obj.todos)) return { todos: obj.todos };
    return null;
  } catch (e) {
    console.warn("[TodoSenseBox] args 解析失败，退化 JSON 显示", e);
    return null;
  }
});

const todos = computed(() => parsed.value?.todos ?? []);
const fallback = computed(() => (parsed.value ? "" : JSON.stringify(props.call.args ?? {}, null, 2)));
const doneCount = computed(() => todos.value.filter((t) => t.status === "completed").length);

const statusGlyph = (s: TodoItem["status"]): string =>
  s === "completed" ? "✓" : s === "in_progress" ? "▣" : "☐";
</script>

<template>
  <div class="todo-box">
    <div class="todo-head">
      <span class="todo-icon" aria-hidden="true">📋</span>
      <span class="todo-name">待办</span>
      <span class="todo-count">{{ doneCount }}/{{ todos.length }}</span>
    </div>
    <ul v-if="todos.length" class="todo-list">
      <li v-for="(t, i) in todos" :key="i" class="todo-item" :class="`is-${t.status}`">
        <span class="glyph" aria-hidden="true">{{ statusGlyph(t.status) }}</span>
        <span class="content">
          <span class="text" :class="{ done: t.status === 'completed' }">{{ t.content }}</span>
          <span v-if="t.status === 'in_progress' && t.activeForm" class="active-form">{{ t.activeForm }}</span>
        </span>
      </li>
    </ul>
    <pre v-else-if="fallback" class="todo-fallback">{{ fallback }}</pre>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.todo-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.66);
  font-size: 11px;
  color: fade(@ink, 80%);
}

.todo-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .todo-icon {
    font-size: 11px;
  }

  .todo-name {
    flex: 1;
    font-weight: 700;
    color: fade(@ink, 86%);
  }

  .todo-count {
    font-size: 10px;
    font-weight: 700;
    color: fade(@ink, 56%);
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
}

.todo-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  min-width: 0;

  .glyph {
    flex-shrink: 0;
    font-size: 10px;
    line-height: 1.45;
  }

  .content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .text {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.45;

    &.done {
      text-decoration: line-through;
      color: fade(@ink, 44%);
    }
  }

  .active-form {
    font-size: 9.5px;
    font-style: italic;
    color: fade(@ink, 50%);
  }

  &.is-in_progress .glyph {
    color: #eab308;
    animation: todo-pulse 1.1s ease-in-out infinite;
  }
  &.is-completed .glyph {
    color: #16a34a;
  }
}

.todo-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.06);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}

@keyframes todo-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
