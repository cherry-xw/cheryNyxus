<script setup lang="ts">
/**
 * SenseCallBox：sense 调用独立 box（assistant 消息内子项）。
 * 渲染位置：MessageBubble 内嵌（非独立顶层项）。
 * 理由：store.accumulateStaged 把 senseCalls 挂在所属 assistant HistoryItem 上（last.senseCalls.push），
 *   嵌套渲染保持数据与视觉归属一致；独立顶层需 drawer 侧扁平化，丢失"哪个 agent 调的"上下文 + 打乱时序。
 * 显示：senseName + 状态指示（running⋯ / done✓ / error✗）+ args（可折叠，默认收起）+ result（可折叠，默认收起）。
 * args 渲染：解析为 object（string 先 JSON.parse）。有 description 字段 → 其值作折叠标题；否则标题 'arguments'。
 *   展开显其余字段 key:value 行。解析失败 → fallback JSON pre。空值不渲染该 section。
 * result 渲染：unknown → string。后端 staged arguments 契约 = JSON 字符串（store 注释），pretty-print；object 走 JSON.stringify。
 */
import { computed, ref } from 'vue'
import type { SenseCallRecord } from '@/domain/chat/projectionTypes'
import { formatArgValue, formatValue, parseArgs } from '@/utils/parseArgs'
import { toSenseNameZh } from '@/utils/senseName'
import ToolDescriptionDisclosure from '../renderers/ToolDescriptionDisclosure.vue'
import MessageParts from './MessageParts.vue'
import FileOperationSummary from './FileOperationSummary.vue'

const props = defineProps<{
  call: SenseCallRecord
  defaultExpanded?: boolean
  /** 当前会话 id，用于按需读取工具字段说明。 */
  chatId?: string
}>()

const showArgs = ref(props.defaultExpanded ?? false)
const showResult = ref(props.defaultExpanded ?? false)

const argsParsed = computed(() => parseArgs(props.call.args))
const argsFallback = computed(() => argsParsed.value.fallback)
const argsEntries = computed(() => argsParsed.value.parsed?.entries ?? [])
// 参数折叠标题保持「参数」文案；不再把本次调用里的 description 值当作折叠标题
// （那是本次调用参数，不是工具的固定说明）。
const argsToggleLabel = computed(() => '参数')
const hasArgs = computed(() => {
  const { parsed, fallback } = argsParsed.value
  if (parsed) return parsed.description != null || parsed.entries.length > 0
  return fallback.length > 0
})

const resultText = computed(() => formatValue(props.call.result))
const isServerExecuted = computed(() => props.call.executionOwner === 'server')
const showSources = ref(props.defaultExpanded ?? false)

const statusGlyph = computed(() => {
  if (props.call.serverState === 'unknown' || props.call.serverState === 'skipped-local') return '—'
  switch (props.call.status) {
    case 'running':
      return '⋯'
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    default:
      return '?'
  }
})

const statusClass = computed(() =>
  props.call.serverState === 'unknown' || props.call.serverState === 'skipped-local'
    ? 'status-unknown'
    : `status-${props.call.status}`,
)
</script>

<template>
  <div class="sense-box" :class="{ 'is-server-tool': isServerExecuted }">
    <div class="sense-head">
      <span class="sense-icon" aria-hidden="true">{{ isServerExecuted ? '☁' : '⚙' }}</span>
      <ToolDescriptionDisclosure
        class="sense-name"
        :tool-name="toSenseNameZh(props.call.name)"
        :tool-key="props.call.name"
        :chat-id="chatId"
        :execution-owner="props.call.executionOwner"
      />
      <span v-if="isServerExecuted" class="server-owner-badge">
        {{ props.call.serverState === 'skipped-local' ? '已由云端完成（跳过本地）' : '由模型服务执行' }}
      </span>
      <slot v-if="!isServerExecuted" name="risk" />
      <span class="sense-status" :class="statusClass" aria-hidden="true">{{ statusGlyph }}</span>
    </div>
    <div v-if="hasArgs" class="sense-section">
      <button type="button" class="toggle" :aria-expanded="showArgs" @click="showArgs = !showArgs">
        <span class="caret" :class="{ open: showArgs }">▸</span>
        <span class="toggle-label">{{ argsToggleLabel }}</span>
      </button>
      <div v-if="showArgs" class="args-body">
        <div v-if="argsEntries.length" class="arg-rows">
          <div v-for="entry in argsEntries" :key="entry.key" class="arg-row">
            <span class="arg-key">{{ entry.key }}:</span>
            <span class="arg-val">{{ formatArgValue(entry.value) }}</span>
          </div>
        </div>
        <pre v-else-if="argsFallback" class="sense-pre">{{ argsFallback }}</pre>
        <span v-else class="arg-empty">(无其他参数)</span>
      </div>
    </div>
    <FileOperationSummary v-if="call.fileOperations?.length" :operations="call.fileOperations" />
    <div v-if="call.sources?.length" class="sense-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showSources"
        @click="showSources = !showSources"
      >
        <span class="caret" :class="{ open: showSources }">▸</span>
        来源（{{ call.sources.length }}）
      </button>
      <ul v-if="showSources" class="sense-sources">
        <li v-for="(src, idx) in call.sources" :key="idx" class="sense-source-item">
          <a :href="src.url" target="_blank" rel="noopener noreferrer" class="sense-source-link">
            {{ src.title || src.url }}
          </a>
          <span v-if="src.refer" class="sense-source-refer">[{{ src.refer }}]</span>
          <p v-if="src.snippet" class="sense-source-snippet">{{ src.snippet }}</p>
        </li>
      </ul>
    </div>
    <div v-if="resultText || call.parts?.length" class="sense-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showResult"
        @click="showResult = !showResult"
      >
        <span class="caret" :class="{ open: showResult }">▸</span>
        结果{{ call.parts?.some(part => part.type === 'asset') ? `（${call.parts.filter(part => part.type === 'asset').length} 个文件）` : '' }}
      </button>
      <MessageParts v-if="showResult && call.parts?.length" :parts="call.parts" :chat-id="chatId" />
      <pre v-else-if="showResult" class="sense-pre">{{ resultText }}</pre>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.sense-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  /* 未知工具通用渲染器：用不透明表面，避免在深色主题 / 折叠 tag 悬浮层上
     内容与背后背景重叠导致文字不清（与已注册专用渲染器的 var(--surface) 一致）。 */
  background: var(--surface);
  font-size: 13px;
  color: color-mix(in srgb, var(--ink) 80%, transparent);
}

.sense-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .sense-icon {
    font-size: 13px;
    opacity: 0.7;
  }

  .sense-name {
    flex: 1;
    min-width: 0;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
    word-break: break-all;
  }

  .sense-name :deep(.tool-description-trigger) {
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .sense-status {
    font-weight: 800;
    font-size: 14px;

    &.status-done {
      color: #16a34a;
    }
    &.status-running {
      color: #eab308;
      animation: sense-pulse 1.1s ease-in-out infinite;
    }
    &.status-error {
      color: #dc2626;
    }
    &.status-unknown {
      color: color-mix(in srgb, var(--ink) 50%, transparent);
    }
  }

  .server-owner-badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ink) 10%, transparent);
    color: color-mix(in srgb, var(--ink) 74%, transparent);
    white-space: nowrap;
  }
}

.sense-sources {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.sense-source-item {
  line-height: 1.4;
}

.sense-source-link {
  color: var(--accent, #2563eb);
  text-decoration: none;
  word-break: break-all;

  &:hover {
    text-decoration: underline;
  }
}

.sense-source-refer {
  margin-left: 4px;
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
}

.sense-source-snippet {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}

.sense-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toggle {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;
  text-align: left;

  &:hover {
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .toggle-label {
    white-space: normal;
    word-break: break-word;
  }
}

.caret {
  display: inline-block;
  transition: transform 140ms ease;

  &.open {
    transform: rotate(90deg);
  }
}

.args-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 12px;
}

.arg-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.arg-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.arg-key {
  flex-shrink: 0;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 12.5px;
  font-weight: 400;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
}

.arg-val {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.45;
  color: color-mix(in srgb, var(--ink) 86%, transparent);
  max-height: 160px;
  overflow: auto;
}

.arg-empty {
  font-size: 12px;
  font-style: italic;
  color: color-mix(in srgb, var(--ink) 44%, transparent);
}

.sense-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: color-mix(in srgb, var(--ink) 86%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}

@keyframes sense-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>

<!-- 深色模式提亮（无 scoped 块）：仅提亮前景文字/图标。 -->
<style lang="less">
[data-theme='dark'] .sense-head .sense-status.status-error {
  color: #f87171;
}
</style>
