<script setup lang="ts">
import { computed } from 'vue'
import { parseArgs } from '@/utils/parseArgs'

const props = withDefaults(defineProps<{ args: unknown; embedded?: boolean }>(), {
  embedded: false,
})
type Preview = { path: string; before: string; after: string; kind: 'create' | 'modify' | 'delete' }
type PreviewPayload = { files?: Preview[]; error?: string }

const preview = computed<PreviewPayload | null>(() => {
  const value = parseArgs(props.args).parsed?.entries.find(
    (entry) => entry.key === '__filePreview',
  )?.value
  if (!value || typeof value !== 'object') return null
  const payload = value as Partial<PreviewPayload & Preview>
  const files = Array.isArray(payload.files) ? payload.files : [payload]
  const valid = files
    .filter(
      (item): item is Preview =>
        typeof item?.path === 'string' &&
        typeof item.before === 'string' &&
        typeof item.after === 'string',
    )
    .map((item): Preview => ({
      ...item,
      kind: item.kind === 'create' || item.kind === 'delete' ? item.kind : 'modify',
    }))
  return valid.length || typeof payload.error === 'string'
    ? { files: valid, error: payload.error }
    : null
})

type DiffLine = { kind: 'add' | 'remove' | 'same'; text: string }
function diffLines(beforeText: string, afterText: string): DiffLine[] {
  const before = beforeText.split('\n')
  const after = afterText.split('\n')
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let row = before.length - 1; row >= 0; row--) {
    for (let col = after.length - 1; col >= 0; col--) {
      table[row]![col] =
        before[row] === after[col]
          ? table[row + 1]![col + 1]! + 1
          : Math.max(table[row + 1]![col]!, table[row]![col + 1]!)
    }
  }
  const output: DiffLine[] = []
  let row = 0
  let col = 0
  while (row < before.length || col < after.length) {
    if (row < before.length && col < after.length && before[row] === after[col]) {
      output.push({ kind: 'same', text: before[row++]! })
      col++
    } else if (
      col < after.length &&
      (row === before.length || table[row]![col + 1]! >= table[row + 1]![col]!)
    ) {
      output.push({ kind: 'add', text: after[col++]! })
    } else {
      output.push({ kind: 'remove', text: before[row++]! })
    }
  }
  return output
}
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
      <pre><span v-for="(line, index) in diffLines(file.before, file.after)" :key="index" :class="line.kind">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}{{ line.text }}
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
