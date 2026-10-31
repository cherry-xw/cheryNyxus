<script setup lang="ts">
import { computed } from 'vue'
import type { SourceVisibleBody } from '../../../packages/protocol/src/sourceManagement'
import type { useQqSources } from './useQqSources'
const props=defineProps<{requestId:string;body:SourceVisibleBody;reader:ReturnType<typeof useQqSources>}>()
const loaded=computed(()=>props.reader.body(props.requestId,props.body))
</script>
<template>
  <template v-if="body.state==='available' && loaded">
    <pre>{{ loaded.value || '（无文字）' }}</pre>
    <p v-if="loaded.nextCursor">以下为部分内容（已读取 {{ loaded.end }} / {{ body.text.totalCodePoints }} 个字符）。
      <button type="button" :disabled="loaded.loading" @click="reader.text(requestId,body.text)">{{ loaded.loading?'读取中…':'继续读取正文' }}</button>
    </p>
    <p v-if="loaded.error" role="alert">{{ loaded.error }}</p>
  </template>
  <p v-else>{{ body.state==='unavailable' && body.reason==='permission_denied'?'无权读取正文。':'未记录可公开的正文。' }}</p>
</template>
<style scoped>pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:4px 0}p{overflow-wrap:anywhere;margin:4px 0}</style>
