<script setup lang="ts">
/**
 * PromptSnapshotTip：系统提示词快照面板（el-popover content 用）。
 * 两段：① system 消息内容全文（buildFirstSystemPrompt 重建）；② 工具定义列表
 *   （每个工具：name + description + parameters 弱化折叠展示）。
 * 数据由父级拉取后传入（父级 hover 顶部「上下文」标签触发 chat.promptSnapshot RPC）。
 */
import { ref } from 'vue'
import type { PromptSnapshotTool } from '@/services/agentApi'

defineProps<{
  /** system 消息全文（<system-reminder>+<environment>+<workspace>+<memory>+<skills>）。 */
  systemPrompt: string
  /** 当前 runtime 启用的工具定义。 */
  tools: PromptSnapshotTool[]
  /** 加载/错误态：'idle' | 'loading' | 'error' | 'loaded'。idle/loading 显占位。 */
  status: 'idle' | 'loading' | 'error' | 'loaded'
  /** status='error' 时的错误消息。 */
  error?: string
}>()

// 各工具参数区折叠态（按工具名索引；默认收起，弱化展示）
const openParams = ref<Set<string>>(new Set())
function toggleParams(name: string): void {
  if (openParams.value.has(name)) openParams.value.delete(name)
  else openParams.value.add(name)
}

// 参数 schema 弱化展示：抽取 properties 的字段名/类型/required 标记，不渲染 schema 全文。
function paramFields(
  tool: PromptSnapshotTool,
): Array<{ name: string; type: string; required: boolean }> {
  const params = tool.parameters
  if (!params?.properties) return []
  const required = new Set(params.required ?? [])
  return Object.entries(params.properties).map(([k, v]) => ({
    name: k,
    type: Array.isArray((v as { type?: unknown }).type)
      ? (v as { type: string[] }).type.join('|')
      : ((v as { type?: string }).type ?? 'any'),
    required: required.has(k),
  }))
}
</script>

<template>
  <div class="ps-panel">
    <div v-if="status === 'loading' || status === 'idle'" class="ps-status">重建系统提示词…</div>
    <div v-else-if="status === 'error'" class="ps-status ps-error">{{ error ?? '加载失败' }}</div>
    <template v-else>
      <section class="ps-section">
        <div class="ps-section-title">系统消息内容(基于最新发送消息构建)</div>
        <pre class="ps-pre">{{ systemPrompt }}</pre>
      </section>
      <section class="ps-section">
        <div class="ps-section-title">
          工具定义<span class="ps-count">{{ tools.length }}</span>
        </div>
        <div v-if="tools.length === 0" class="ps-empty">
          无工具（模型不支持 Tool Call 或未配感官组）
        </div>
        <div v-for="tool in tools" :key="tool.name" class="ps-tool">
          <div class="ps-tool-head">
            <span class="ps-tool-name">{{ tool.name }}</span>
          </div>
          <div class="ps-tool-desc">{{ tool.description }}</div>
          <button
            v-if="tool.parameters && paramFields(tool).length > 0"
            type="button"
            class="ps-params-toggle"
            @click="toggleParams(tool.name)"
          >
            <span class="ps-caret" :class="{ open: openParams.has(tool.name) }">▸</span>
            参数 · {{ paramFields(tool).length }}
          </button>
          <div v-if="openParams.has(tool.name)" class="ps-params">
            <div v-for="f in paramFields(tool)" :key="f.name" class="ps-param-row">
              <span class="ps-param-name">{{ f.name }}</span>
              <span class="ps-param-type">{{ f.type }}</span>
              <span v-if="f.required" class="ps-param-req">required</span>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped lang="less">
.ps-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 460px;
  max-width: 460px;
  max-height: 60vh;
  overflow: auto;
}
.ps-status {
  padding: 8px;
  color: rgba(20, 22, 26, 0.5);
  font-size: 12px;
}
.ps-error {
  color: #b91c1c;
}
.ps-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ps-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgba(20, 22, 26, 0.82);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.ps-count {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.14);
  color: #047857;
  font-size: 10px;
}
.ps-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.05);
  color: rgba(20, 22, 26, 0.8);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.ps-empty {
  color: rgba(20, 22, 26, 0.4);
  font-size: 11px;
}
.ps-tool {
  padding: 6px 8px;
  border: 1px solid rgba(20, 22, 26, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.55);
}
.ps-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ps-tool-name {
  color: #047857;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
}
.ps-tool-desc {
  color: rgba(20, 22, 26, 0.66);
  font-size: 10.5px;
  line-height: 1.45;
}
.ps-params-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
  padding: 1px 5px;
  border: none;
  background: transparent;
  color: rgba(20, 22, 26, 0.46);
  font-size: 10px;
  cursor: pointer;
}
.ps-caret {
  display: inline-block;
  transition: transform 140ms ease;
  &.open {
    transform: rotate(90deg);
  }
}
.ps-params {
  margin-top: 4px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.04);
}
.ps-param-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  line-height: 1.5;
}
.ps-param-name {
  color: rgba(20, 22, 26, 0.7);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
.ps-param-type {
  color: rgba(20, 22, 26, 0.44);
  font-size: 9.5px;
}
.ps-param-req {
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(180, 83, 9, 0.12);
  color: #b45309;
  font-size: 9px;
}
</style>
