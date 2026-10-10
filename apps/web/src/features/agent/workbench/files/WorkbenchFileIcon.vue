<script setup lang="ts">
import { computed } from 'vue'
import { fileType } from './fileType'
const props = defineProps<{ name: string; kind: 'file' | 'directory' }>()
const type = computed(() => fileType(props.name, props.kind))
</script>
<template>
  <svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true" class="file-icon">
    <path v-if="type.glyph === 'folder'" d="M3 8h10l3 4h13v15H3Z" />
    <template v-else-if="type.glyph === 'git'">
      <path d="m16 3 13 13-13 13L3 16Z M11 9v12 M11 12l9 7" />
      <circle cx="11" cy="10" r="2" />
      <circle cx="11" cy="22" r="2" />
      <circle cx="21" cy="20" r="2" />
    </template>
    <template v-else-if="type.glyph === 'lock'">
      <path d="M10 13V9a6 6 0 0 1 12 0v4 M7 13h18v15H7Z M16 19v4" />
    </template>
    <template v-else>
      <path d="M6 3h13l7 7v19H6Z M19 3v8h7" />
      <text x="16" y="23" text-anchor="middle">{{ type.label }}</text>
    </template>
  </svg>
</template>
<style scoped>
.file-icon {
  flex: none;
  color: var(--accent, var(--el-color-primary));
}
path,
circle {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linejoin: round;
}
text {
  fill: currentColor;
  font: 8px monospace;
}
</style>
