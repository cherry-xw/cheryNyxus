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
import type { SenseCallRecord } from '@/stores/agents'
import { formatArgValue, formatValue, parseArgs } from '@/utils/parseArgs'
import { extractMediaUrls } from '@/utils/markdown'
import MediaInlineRenderer from '../dialog/media/MediaInlineRenderer.vue'

const props = defineProps<{ call: SenseCallRecord; defaultExpanded?: boolean }>()

const showArgs = ref(props.defaultExpanded ?? false)
const showResult = ref(props.defaultExpanded ?? false)

const argsParsed = computed(() => parseArgs(props.call.args))
const argsFallback = computed(() => argsParsed.value.fallback)
const argsEntries = computed(() => argsParsed.value.parsed?.entries ?? [])
const argsToggleLabel = computed(() => argsParsed.value.parsed?.description ?? 'arguments')
const hasArgs = computed(() => {
  const { parsed, fallback } = argsParsed.value
  if (parsed) return parsed.description != null || parsed.entries.length > 0
  return fallback.length > 0
})

const resultText = computed(() => formatValue(props.call.result))

const resultMediaAssets = computed(() => {
  const text = typeof props.call.result === 'string' ? props.call.result : ''
  return extractMediaUrls(text)
})

const statusGlyph = computed(() => {
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

const statusClass = computed(() => `status-${props.call.status}`)
</script>

<template>
  <div class="sense-box">
    <div class="sense-head">
      <span class="sense-icon" aria-hidden="true">⚙</span>
      <span class="sense-name">{{ props.call.name || '(unknown sense)' }}</span>
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
    <div v-if="resultText" class="sense-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showResult"
        @click="showResult = !showResult"
      >
        <span class="caret" :class="{ open: showResult }">▸</span>
        result
      </button>
      <pre v-if="showResult" class="sense-pre">{{ resultText }}</pre>
      <!-- sense 结果内联媒体预览 -->
      <MediaInlineRenderer v-if="resultMediaAssets.length > 0" :assets="resultMediaAssets" />
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
  background: var(--surface-soft);
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 80%, transparent);
}

.sense-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .sense-icon {
    font-size: 11px;
    opacity: 0.7;
  }

  .sense-name {
    flex: 1;
    font-weight: 700;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
    word-break: break-all;
  }

  .sense-status {
    font-weight: 800;
    font-size: 12px;

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
  }
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
  font-size: 10px;
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
  font-size: 10.5px;
  font-weight: 700;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
}

.arg-val {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  color: color-mix(in srgb, var(--ink) 86%, transparent);
  max-height: 160px;
  overflow: auto;
}

.arg-empty {
  font-size: 10px;
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
  font-size: 10.5px;
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
