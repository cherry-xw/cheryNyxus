<script setup lang="ts">
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'
const props = defineProps<{ text: string; markdown?: boolean }>()
const { html } = useRenderedMarkdown(() => props.text, { mode: 'full' })
</script>
<template>
  <!-- eslint-disable-next-line vue/no-v-html -- shared Markdown renderer disables HTML -->
  <span v-if="markdown" class="md" v-html="html" />
  <span v-else class="plain">{{ text }}</span>
</template>
<style scoped>.plain { white-space:pre-wrap; overflow-wrap:anywhere; }</style>
