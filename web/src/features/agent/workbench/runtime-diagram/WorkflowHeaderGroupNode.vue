<script setup lang="ts">
import type { NodeProps } from '@vue-flow/core'
import type { HeaderChildData } from './headerGraph'
defineProps<NodeProps<Extract<HeaderChildData, { kind: 'header-group' }>>>()
</script>
<template>
  <section class="workflow-header-group" :aria-label="data.title">
    <h3>{{ data.title }}</h3>
  </section>
</template>
<style scoped lang="less">
.workflow-header-group {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  pointer-events: none;
}
h3 {
  margin: 0;
  padding: 18px 24px;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
}
</style>
