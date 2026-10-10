<script setup lang="ts">
import PluginPageShell from '../../../packages/manager-ui/src/PluginPageShell.vue'
import CapabilitiesPanel from './CapabilitiesPanel.vue'
</script>
<template>
  <PluginPageShell id="capabilities" v-slot="{ available }"
    ><CapabilitiesPanel :active="available"
  /></PluginPageShell>
</template>
