<script setup lang="ts">
import { ref } from 'vue'
import WorkbenchTerminal from './WorkbenchTerminal.vue'
import type { TerminalHeaderMeta } from './WorkbenchTerminal.vue'

const props = defineProps<{ presetId: string }>()
const emit = defineEmits<{ meta: [value: TerminalHeaderMeta] }>()
const terminalRef = ref<InstanceType<typeof WorkbenchTerminal> | null>(null)

function clear(): void {
  terminalRef.value?.clear()
}

defineExpose({ clear })
</script>

<template>
  <WorkbenchTerminal
    ref="terminalRef"
    :chat-id="`terminal:${props.presetId}`"
    :initial-preset-id="props.presetId"
    auto-connect
    @meta="emit('meta', $event)"
  />
</template>
