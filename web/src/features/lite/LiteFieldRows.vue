<script setup lang="ts">
/**
 * LiteFieldRows：一列「字段名 + 值」行（LiteToolCallDetail 参数 / 结果共用）。
 * 标量直接展示；关键字段（命令/路径/URL/内容等）用等宽代码块；标量数组逐行点号列表；
 * 嵌套对象/数组递归翻译键后 pretty-print。.
 */
import { formatApprovalArgumentScalar } from '@/utils/approvalPresentation'
import {
  isScalarValue,
  prettyTranslatedJson,
  scalarArrayItems,
  scalarText,
  type RenderedEntry,
} from './toolRendering'

defineProps<{ entries: RenderedEntry[] }>()

/** 关键字段（命令 / 路径 / URL / 内容等）用等宽代码块展示。 */
function isCodeField(entry: RenderedEntry): boolean {
  const key = entry.key.trim().toLowerCase()
  if (
    [
      'command',
      'cmd',
      'path',
      'file_path',
      'filepath',
      'url',
      'urls',
      'query',
      'pattern',
      'content',
      'prompt',
      'filename',
      'file',
      'output',
      'stdout',
      'stderr',
    ].includes(key)
  ) {
    return true
  }
  return typeof entry.value === 'string' && entry.value.includes('\n')
}

function fieldText(entry: RenderedEntry): string {
  if (entry.key === 'action' && isScalarValue(entry.value)) {
    return formatApprovalArgumentScalar(entry.key, entry.value)
  }
  return isScalarValue(entry.value) ? scalarText(entry.value) : prettyTranslatedJson(entry.value)
}

/** 字段值若是「标量数组」（选项/文件列表/标签等）→ 每项一行的文本列表；其余返回 null（走 code/pre）。 */
function fieldListItems(entry: RenderedEntry): string[] | null {
  if (isCodeField(entry) || isScalarValue(entry.value)) return null
  return scalarArrayItems(entry.value)
}
</script>

<template>
  <div
    v-for="entry in entries"
    :key="entry.key"
    class="lite-field"
    :class="{ 'is-code': isCodeField(entry) }"
  >
    <span class="lite-field-key">{{ entry.label }}</span>
    <div class="lite-field-val">
      <code v-if="isCodeField(entry)" class="lite-field-code">{{ fieldText(entry) }}</code>
      <template v-else-if="isScalarValue(entry.value)">
        <span>{{ fieldText(entry) }}</span>
      </template>
      <template v-else-if="fieldListItems(entry)">
        <ul class="lite-list">
          <li v-for="(item, itemIndex) in fieldListItems(entry)" :key="itemIndex">{{ item }}</li>
        </ul>
      </template>
      <pre v-else class="lite-pre">{{ fieldText(entry) }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* 字段行：标题在上、内容在下两行展示（用户需求 2026-11：配置管理更多参数等长内容
   不再被 72px 左栏挤压）；内容允许任意位置断点换行（word-break: break-all）。 */
.lite-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0;
  min-width: 0;
}
.lite-field-key {
  flex: none;
  font-size: 14px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.lite-field-val {
  flex: 1;
  min-width: 0;
}
.lite-field-val > span {
  display: inline-block;
  font-size: 16px;
  line-height: 1.6;
  color: var(--el-text-color-primary);
  white-space: pre-wrap;
  word-break: break-all;
}
.lite-field-code {
  display: block;
  padding: 4px 8px;
  border-radius: 0;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--el-text-color-primary);
  max-height: 220px;
  overflow: auto;
  scrollbar-width: none;
}
/* 标量数组（选项/文件列表/标签等）：每项一行的点号列表。 */
.lite-list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0 0 0 4px;
  list-style: none;
}
.lite-list li {
  position: relative;
  padding-left: 14px;
  color: var(--el-text-color-primary);
  font-size: 16px;
  line-height: 1.55;
  word-break: break-all;
}
.lite-list li::before {
  content: '·';
  position: absolute;
  left: 0;
  color: var(--el-text-color-placeholder);
}
.lite-pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 0;
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--el-text-color-primary);
  max-height: 280px;
  overflow: auto;
  scrollbar-width: none;
}
</style>
