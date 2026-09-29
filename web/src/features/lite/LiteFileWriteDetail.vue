<script setup lang="ts">
/**
 * LiteFileWriteDetail：write_file 专有内容区（精简模式详情抽屉工具链内使用）。
 * 按 类型 → 路径 → 内容 顺序展示；内容以 diff 形式呈现：
 * - 参数含 __filePreview（审批预览携带新旧内容）时用真实 diff；
 * - 无旧内容可对比时整块标「新增」（每行 + 前缀）。
 * 头部（工具名/简介/风险徽章）由 LiteToolCallDetail 统一提供；层级保持扁平，不套边框背景。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import {
  diffFileLines,
  fileChangePreview,
  type FileChangeDiffLine,
} from '@/features/agent/cards/fileChangeDiff'
import { parseJsonValue } from './toolRendering'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const args = computed<Record<string, unknown>>(() => {
  const value = parseJsonValue(props.call.arguments)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
})
const path = computed(() => (typeof args.value.path === 'string' ? args.value.path : ''))
const content = computed(() => (typeof args.value.content === 'string' ? args.value.content : ''))
const offset = computed(() =>
  typeof args.value.offset === 'number' ? args.value.offset : undefined,
)
const limit = computed(() => (typeof args.value.limit === 'number' ? args.value.limit : undefined))
const isPartial = computed(() => offset.value !== undefined && limit.value !== undefined)
/** 写入类型：完整写入（创建/覆盖）或部分写入（修改指定行区间）。 */
const modeLabel = computed(() =>
  isPartial.value
    ? `修改第 ${offset.value} - ${(offset.value ?? 0) + (limit.value ?? 0)} 行`
    : '创建 / 覆盖文件',
)

const preview = computed(() => fileChangePreview(args.value))
const diffError = computed(() => preview.value?.error ?? '')
const diffLines = computed<FileChangeDiffLine[] | null>(() => {
  const p = preview.value
  if (p?.error) return null
  if (p?.files.length) {
    const file = p.files[0]!
    return diffFileLines(file.before, file.after)
  }
  // 无 __filePreview：无旧内容可对比，整块内容按「新增」展示。
  if (!content.value) return null
  return content.value.split('\n').map((text) => ({ kind: 'add' as const, text }))
})
</script>

<template>
  <div class="lite-file-write">
    <div class="lite-fw-row">
      <span class="lite-fw-label">类型</span>
      <span class="lite-fw-value">{{ modeLabel }}</span>
    </div>
    <div v-if="path" class="lite-fw-row">
      <span class="lite-fw-label">路径</span>
      <code class="lite-fw-path">{{ path }}</code>
    </div>
    <template v-if="diffLines">
      <div class="lite-fw-label">内容</div>
      <pre class="lite-fw-diff"><span
          v-for="(line, index) in diffLines"
          :key="index"
          :class="line.kind"
          >{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}{{ line.text }}
</span></pre>
    </template>
    <p v-else-if="diffError" class="lite-fw-error">无法生成差异：{{ diffError }}</p>
    <p v-else class="lite-fw-empty">（无内容）</p>
  </div>
</template>

<style scoped>
/* 写文件内容区：扁平字段行 + diff，不套边框/背景（层级保持扁平）。 */
.lite-file-write {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.lite-fw-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.lite-fw-label {
  flex: none;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.lite-fw-value {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-size: 15px;
  line-height: 1.5;
  word-break: break-word;
}
.lite-fw-path {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.lite-fw-diff {
  margin: 0;
  padding: 6px 8px;
  background: var(--el-fill-color-blank);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow: auto;
  scrollbar-width: none;
}
.lite-fw-diff .add {
  color: #16803a;
  background: #dcfce7;
}
.lite-fw-diff .remove {
  color: #b42318;
  background: #fee2e2;
}
.lite-fw-diff .same {
  color: var(--el-text-color-primary);
}
.lite-fw-error {
  margin: 0;
  color: var(--el-color-danger);
  font-size: 14px;
  line-height: 1.5;
}
.lite-fw-empty {
  margin: 0;
  color: var(--el-text-color-placeholder);
  font-size: 14px;
  line-height: 1.5;
}
</style>
