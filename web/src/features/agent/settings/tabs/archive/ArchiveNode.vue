<script setup lang="ts">
import type { ArchiveNode } from './model'
defineProps<{ node: ArchiveNode }>()
defineEmits<{ view: [chatId: string] }>()
</script>

<template>
  <li class="archive-node" :class="{ matched: node.matched }">
    <div class="node-row">
      <span class="node-role"
        >{{ node.chat.avatar || '◇' }} {{ node.label }}
        <span class="node-relation">{{ node.relation }}</span></span
      >
      <span class="node-count">{{ node.chat.messageCount }} 条消息</span>
      <button type="button" @click="$emit('view', node.chat.chatId)">查看对话</button>
    </div>
    <p>{{ node.chat.preview || '暂无消息摘要' }}</p>
    <details v-if="node.children.length" :open="node.expand">
      <summary>关联 Agent / 分支 · {{ node.children.length }}</summary>
      <ul>
        <ArchiveNode
          v-for="child in node.children"
          :key="child.chat.chatId"
          :node="child"
          @view="$emit('view', $event)"
        />
      </ul>
    </details>
  </li>
</template>

<style scoped>
.archive-node {
  list-style: none;
  padding: 10px 12px;
  border-left: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.matched {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.node-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
}
.node-role {
  flex: 1;
  min-width: 140px;
}
.node-relation,
.node-count {
  font-size: 12px;
  color: var(--ink-muted, var(--ink));
}
p {
  margin: 6px 0;
  font-size: 12px;
}
ul {
  padding-left: 12px;
  margin: 8px 0 0;
}
summary {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
}
button {
  background: var(--surface);
  color: var(--accent);
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 5px 9px;
  cursor: pointer;
  font: inherit;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
