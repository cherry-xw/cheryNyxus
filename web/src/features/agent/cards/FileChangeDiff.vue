<script setup lang="ts">
import { computed } from 'vue'
import { diffFileLines, fileChangePreview } from './fileChangeDiff'

const props = withDefaults(defineProps<{ args: unknown; embedded?: boolean }>(), {
  embedded: false,
})
const preview = computed(() => fileChangePreview(props.args))
</script>

<template>
  <component
    :is="props.embedded ? 'div' : 'details'"
    v-if="preview"
    class="file-diff"
    :class="{ 'is-embedded': props.embedded }"
    :open="props.embedded ? undefined : true"
  >
    <summary v-if="!props.embedded">文件差异</summary>
    <p v-if="preview.error" class="preview-error">无法生成差异：{{ preview.error }}</p>
    <section v-for="file in preview.files" :key="file.path" class="file-change">
      <strong
        >{{ file.kind === 'create' ? '新增' : file.kind === 'delete' ? '归档' : '修改' }}
        <code>{{ file.path }}</code></strong
      >
      <pre><span v-for="(line, index) in diffFileLines(file.before, file.after)" :key="index" :class="line.kind">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}{{ line.text }}
</span></pre>
    </section>
  </component>
</template>

<style scoped>
.file-diff {
  width: 100%;
  font-size: 12px;
}
summary {
  cursor: pointer;
}
code,
pre {
  font-family: ui-monospace, Consolas, monospace;
}
.file-change {
  margin-top: 6px;
}
pre {
  max-height: 280px;
  overflow: auto;
  margin: 4px 0;
  padding: 6px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  white-space: pre-wrap;
}
.add {
  color: #16803a;
  background: #dcfce7;
}
.remove {
  color: #b42318;
  background: #fee2e2;
}
.same {
  color: var(--ink);
}
.preview-error {
  color: #b42318;
  margin: 6px 0;
}
</style>
