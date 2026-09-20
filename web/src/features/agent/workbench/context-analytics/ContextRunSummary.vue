<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AnalyticsOperation, ContextAnalyticsDemo } from './model'
import ContextOperationList from './ContextOperationList.vue'
import { formatDuration } from './presentation'
const props = defineProps<{ model: ContextAnalyticsDemo }>()
const filter = ref<AnalyticsOperation['kind'] | 'all' | null>(null)
const kinds = [{ key: 'compression', label: '压缩' }, { key: 'write', label: '写入' }, { key: 'read', label: '读取' }, { key: 'search', label: '搜索' }, { key: 'command', label: '指令' }] as const
const operations = computed(() => (props.model.operations ?? []).filter(o => filter.value === 'all' ? o.kind !== 'compression' : o.kind === filter.value))
const calls = computed(() => props.model.tools.reduce((sum, tool) => sum + tool.calls, 0))
function count(kind: AnalyticsOperation['kind']): number | string {
  return props.model.operations ? props.model.operations.filter(o => o.kind === kind).length : '未知'
}
</script>
<template>
  <section class="run-summary">
    <h3>操作与内容</h3>
    <div class="metrics compact">
      <button type="button" :aria-expanded="filter === 'all'" @click="filter = filter === 'all' ? null : 'all'"><span>工具总调用 · 查看记录</span><p>{{ calls }} 次</p></button>
      <button v-for="kind in kinds" :key="kind.key" type="button" :aria-expanded="filter === kind.key" @click="filter = filter === kind.key ? null : kind.key"><span>{{ kind.label }} · 查看记录</span><p>{{ count(kind.key) }} 次</p></button>
      <div><span>图片</span><p>{{ model.imageCount ?? '未知' }} 张</p></div>
      <div><span>语音</span><p>{{ model.audioCount ?? '未知' }} 条</p></div>
    </div>
    <section v-if="filter" class="records"><header><h3>{{ filter === 'all' ? '全部工具操作' : kinds.find(k => k.key === filter)?.label + '记录' }} · {{ operations.length }} 项</h3><button type="button" @click="filter = null">收起记录</button></header><ContextOperationList :operations="operations" /></section>
    <h3>工具调用</h3>
    <div class="tool-table-wrap">
      <table class="tool-table">
        <thead><tr><th>工具</th><th>耗时</th><th>调用</th><th>失败</th></tr></thead>
        <tbody><tr v-for="tool in model.tools" :key="tool.name"><td><code>{{ tool.name }}</code></td><td>{{ formatDuration(tool.totalDurationMs) }}</td><td>{{ tool.calls }} 次</td><td>{{ tool.failures }} 次</td></tr></tbody>
      </table>
      <p v-if="!model.tools.length">暂无工具调用</p>
    </div>
  </section>
</template>
<style scoped>
.run-summary { margin-top: 20px; }h3 { margin: 18px 0 10px; font-size: 15px; font-weight: 400; }
.run-summary { container-type: inline-size; }
.metrics, .tools { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: 10px; }
.metrics > * { min-height: 90px; }
.tools { grid-template-columns: 1fr; }
.tools:has(> :last-child:nth-child(2n)) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.tools:has(> :last-child:nth-child(4n)) { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@container (max-width: 860px) {
  .metrics, .tools:has(> :last-child:nth-child(2n)) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@container (max-width: 440px) {
  .metrics, .tools:has(> :last-child:nth-child(n)) { grid-template-columns: 1fr; }
}
.metrics > *, .tools article { min-width: 0; padding: 14px; border: 1px solid color-mix(in srgb, var(--nx-text) 15%, transparent); background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%); color: inherit; text-align: left; }
button { color: inherit; background: transparent; border: 1px solid color-mix(in srgb, var(--nx-text) 20%, transparent); cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 400; }button[aria-expanded="true"] { border-color: var(--nx-cyan); }
span, small, dt { font-size: 12px; line-height: 1.6; color: color-mix(in srgb, var(--nx-text) 65%, transparent); }p { font-size: 15px; margin: 8px 0 0; font-weight: 400; }code { font-size: 13px; color: var(--nx-cyan); overflow-wrap: anywhere; }
dl { display: flex; flex-wrap: wrap; gap: 20px; margin: 12px 0 0; }dd { margin: 4px 0 0; font-size: 13px; }.records { margin-top: 14px; padding: 14px; border-left: 2px solid var(--nx-cyan); max-height: 480px; overflow-y: auto; }.records header { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.tool-table-wrap { overflow-x: auto; }
.tool-table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
.tool-table th, .tool-table td { text-align: left; font-weight: 400; padding: 10px 12px; border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent); overflow-wrap: anywhere; }
.tool-table th { color: color-mix(in srgb, var(--nx-text) 65%, transparent); font-size: 12px; }
.tool-table th:first-child { width: 40%; }
.tool-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--nx-text) 3%, transparent); }
</style>
