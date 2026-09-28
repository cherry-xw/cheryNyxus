<script setup lang="ts">
import CyberWindow from './CyberWindow.vue'
import type { WorkspaceWindowGeometry, WorkspaceWindowState } from '@/application/shell/public'

defineProps<{
  window: WorkspaceWindowState
  focus: (id: string) => void
  handlers: {
    opened: (id: string) => void
    minimize: (id: string) => void
    requestClose: (id: string) => void | Promise<void>
    closed: (id: string) => void
    geometry: (id: string, geometry: WorkspaceWindowGeometry) => void
    toggleMaximize: (id: string) => void
  }
}>()
</script>

<template>
  <CyberWindow
    :window="window"
    @focus="focus"
    @opened="handlers.opened"
    @minimize="handlers.minimize"
    @request-close="handlers.requestClose"
    @closed="handlers.closed"
    @geometry="handlers.geometry"
    @toggle-maximize="handlers.toggleMaximize"
  >
    <template #default><slot /></template>
    <template v-if="$slots['title-actions']" #title-actions><slot name="title-actions" /></template>
  </CyberWindow>
</template>
