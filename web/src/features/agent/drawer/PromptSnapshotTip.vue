<script setup lang="ts">
/**
 * PromptSnapshotTip：系统提示词快照面板（el-popover content 用）。
 * 两段：① system 消息内容全文（buildFirstSystemPrompt 重建）；② 工具定义列表
 *   （每个工具：name + description + parameters 弱化折叠展示）。
 * 数据由父级拉取后传入（父级 hover 顶部「上下文」标签触发 chat.promptSnapshot RPC）。
 */
import { ref } from 'vue'
import type { ChatEpochSummary, PromptSnapshotTool } from '@/application/backend/public'

defineProps<{
  /** system 消息全文（<system-reminder>+<environment>+<workspace>+<memory>+<skills>）。 */
  systemPrompt: string
  /** 当前 runtime 启用的工具定义。 */
  tools: PromptSnapshotTool[]
  /** 加载/错误态：'idle' | 'loading' | 'error' | 'loaded'。idle/loading 显占位。 */
  status: 'idle' | 'loading' | 'error' | 'loaded'
  /** status='error' 时的错误消息。 */
  error?: string
  epochs?: ChatEpochSummary[]
  selectedEpochId?: string
  activeEpochId?: string
  snapshotQuality?: 'exact' | 'partial' | 'reconstructed'
}>()
const emit = defineEmits<{ epochChange: [epochId: string] }>()

// 各工具参数区折叠态（按工具名索引；默认收起，弱化展示）
const openParams = ref<Set<string>>(new Set())
function toggleParams(name: string): void {
  if (openParams.value.has(name)) openParams.value.delete(name)
  else openParams.value.add(name)
}

// 参数 schema 弱化展示：抽取 properties 的字段名/类型/required 标记，不渲染 schema 全文。
function paramFields(
  tool: PromptSnapshotTool,
): Array<{ name: string; type: string; required: boolean; description?: string }> {
  const params = tool.parameters
  if (!params?.properties) return []
  const required = new Set(params.required ?? [])
  return Object.entries(params.properties).map(([k, v]) => ({
    name: k,
    type: Array.isArray((v as { type?: unknown }).type)
      ? (v as { type: string[] }).type.join('|')
      : ((v as { type?: string }).type ?? 'any'),
    required: required.has(k),
    description:
      typeof (v as { description?: unknown }).description === 'string'
        ? (v as { description: string }).description
        : undefined,
  }))
}
</script>

<template>
  <div class="ps-panel">
    <div v-if="epochs && epochs.length > 0" class="ps-epoch-bar">
      <label class="ps-epoch-label" for="prompt-snapshot-epoch">上下文纪元</label>
      <select
        id="prompt-snapshot-epoch"
        class="ps-epoch-select"
        :value="selectedEpochId"
        @change="emit('epochChange', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="epoch in epochs" :key="epoch.epochId" :value="epoch.epochId">
          {{ epoch.label }}{{ epoch.epochId === activeEpochId ? ' · 当前可用' : ' · 只读' }}
        </option>
      </select>
      <span v-if="selectedEpochId !== activeEpochId" class="ps-readonly">只读历史</span>
    </div>
    <div
      v-if="snapshotQuality && snapshotQuality !== 'exact'"
      class="ps-quality-warning"
    >
      此纪元为{{ snapshotQuality === 'reconstructed' ? '重建' : '部分' }}快照，无法保证还原当时的完整配置。
    </div>
    <div v-if="status === 'loading' || status === 'idle'" class="ps-status">重建系统提示词…</div>
    <div v-else-if="status === 'error'" class="ps-status ps-error">{{ error ?? '加载失败' }}</div>
    <template v-else>
      <section class="ps-section">
        <div class="ps-section-title">冻结的系统消息内容</div>
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
          <div class="ps-tool-body">
            <div class="ps-tool-desc">{{ tool.description }}</div>
          </div>
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
              <span
                v-if="f.description"
                class="ps-param-desc"
                :title="f.description"
              >{{ f.description }}</span>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped lang="less">
@import '@/styles/scrollbar.less';

.ps-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 460px;
  margin: -6px -12px;
  max-width: 460px;
  max-height: 60vh;
  overflow: auto;
  .inner-scrollbar(); /* 内层滚动：prompt 快照弹窗，弱化滚动条 */
}
/* 内部二级滚动区：保留滚动行为，隐藏滚动条 UI */
.ps-panel * {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.ps-panel *::-webkit-scrollbar {
  display: none;
}
.ps-status {
  padding: 8px;
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  font-size: 12px;
}
.ps-epoch-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 8px;
}
.ps-epoch-label {
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  font-size: 10.5px;
  flex-shrink: 0;
}
.ps-epoch-select {
  min-width: 0;
  flex: 1;
  padding: 3px 6px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 5px;
  background: var(--surface-soft);
  color: var(--ink);
  font-size: 10.5px;
}
.ps-readonly {
  color: #b45309;
  font-size: 9.5px;
  flex-shrink: 0;
}
.ps-quality-warning {
  margin: 0 8px;
  padding: 5px 7px;
  border-radius: 5px;
  background: rgba(180, 83, 9, 0.1);
  color: #92400e;
  font-size: 10px;
  line-height: 1.4;
}
.ps-error {
  color: var(--danger);
}
.ps-section {
  display: flex;
  flex-direction: column;
  margin: 0 8px;
  gap: 4px;
}
.ps-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  font-size: 11px;
  font-weight: 600;
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
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  color: color-mix(in srgb, var(--ink) 80%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}
.ps-empty {
  color: color-mix(in srgb, var(--ink) 40%, transparent);
  font-size: 11px;
}
.ps-tool {
  display: flex;
  flex-direction: column;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  overflow: hidden;
}
.ps-tool-body {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ps-tool-head {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
}
.ps-tool-name {
  color: #047857;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
}
.ps-tool-desc {
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.ps-params-toggle {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  margin-top: 3px;
  padding: 1px 5px;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 46%, transparent);
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
  flex-shrink: 0;
  margin-top: 4px;
  padding: 4px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  overflow: hidden;
}
.ps-param-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  line-height: 1.5;
}
.ps-param-name {
  color: #047857;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-weight: 600;
  flex-shrink: 0;
}
.ps-param-type {
  color: color-mix(in srgb, var(--ink) 44%, transparent);
  font-size: 9.5px;
  flex-shrink: 0;
}
.ps-param-req {
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(180, 83, 9, 0.12);
  color: #b45309;
  font-size: 9px;
  flex-shrink: 0;
}
.ps-param-desc {
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 9.5px;
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
  min-width: 0;
}
</style>
