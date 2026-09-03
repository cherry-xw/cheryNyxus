<script setup lang="ts">
/**
 * LiteMarkdown：lite 极简视图专用 markdown 渲染（问题 3：md 原文 → 解析展示）。
 * - 非 plain：renderMarkdown（markdown-it html:false 已转义，XSS 安全）+ highlight.js 代码高亮；
 * - plain：纯文本（用户消息），保留换行 / 空格，不解释 # / * 等语法。
 * 样式按 lite 的 --el-* 变量与 400 字重收敛（不复用 pets 主题的 --ink 系 mixin）。
 */
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'

const props = defineProps<{
  text: string
  /** 纯文本模式：不渲染 markdown（用户消息等应原样保留）。 */
  plain?: boolean
}>()

// 流式 markdown 节流渲染（leading + 240ms trailing）；full 模式全文渲染，
// 不做 12000 字符截断（数据侧 32KB 分页续拉兜底，渲染层保持完整内容）。
const { html: rendered } = useRenderedMarkdown(() => props.text ?? '', { mode: 'full' })
</script>

<template>
  <div v-if="plain" class="lite-md is-plain">{{ text }}</div>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义，XSS 安全 -->
  <div v-else class="lite-md" v-html="rendered" />
</template>

<style scoped>
.lite-md {
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--el-text-color-primary);
  /* 强制字重规则：lite 内容一律 400。 */
  font-weight: 400;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.lite-md.is-plain {
  white-space: pre-wrap;
}
.lite-md :deep(p) {
  margin: 0 0 6px;
}
.lite-md :deep(p:last-child) {
  margin: 0;
}
.lite-md :deep(h1),
.lite-md :deep(h2),
.lite-md :deep(h3),
.lite-md :deep(h4),
.lite-md :deep(h5),
.lite-md :deep(h6) {
  margin: 8px 0 4px;
  font-size: 13px;
  line-height: 1.3;
  font-weight: 600;
}
.lite-md :deep(ul),
.lite-md :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}
.lite-md :deep(li) {
  margin: 2px 0;
}
.lite-md :deep(blockquote) {
  margin: 4px 0;
  padding: 2px 8px;
  border-left: 3px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
}
.lite-md :deep(a) {
  color: var(--el-color-primary);
  text-decoration: underline;
}
.lite-md :deep(code) {
  font-family: var(--el-font-family-mono);
  font-size: 11.5px;
  padding: 1px 4px;
  border-radius: 0;
  background: var(--el-fill-color-light);
}
.lite-md :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 0;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  overflow-x: auto;
  scrollbar-width: none;
}
.lite-md :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: 12px;
  line-height: 1.6;
}
.lite-md :deep(hr) {
  border: none;
  border-top: 1px solid var(--el-border-color);
  margin: 8px 0;
}
.lite-md :deep(img) {
  max-width: 100%;
  border-radius: 0;
}
.lite-md :deep(table) {
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 11.5px;
}
.lite-md :deep(th),
.lite-md :deep(td) {
  border: 1px solid var(--el-border-color);
  padding: 2px 6px;
  font-weight: 400;
}
.lite-md :deep(th) {
  background: var(--el-fill-color-light);
}
</style>
