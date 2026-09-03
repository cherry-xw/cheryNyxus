<script setup lang="ts">
/**
 * LiteToolCallDetail：单条工具调用的结构化详情（问题 2：不同类型分开展示 + JSON 解析 + 英文→中文）。
 * - 外层卡片（.lite-tool-call / .is-focused）由 DetailDrawer 提供，本组件只渲染卡片内部；
 * - 参数 / 结果各自：解析 JSON → 按工具类型高亮关键字段（命令、路径、URL、任务说明…），
 *   其余字段收进「更多」折叠区；嵌套对象 / 数组递归翻译键后 pretty-print；
 * - 解析失败回退原文 <pre>。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import type { LiteToolType } from './executionMonitor'
import { toolTypeGlyph, toolTypeLabel } from './executionMonitor'
import { formatApprovalArgumentScalar } from '@/utils/approvalPresentation'
import RiskBadge from '@/components/RiskBadge.vue'
import {
  isPrimaryField,
  isScalarValue,
  parseJsonValue,
  prettyTranslatedJson,
  readableToolRun,
  scalarText,
  toObjectEntries,
  type RenderedEntry,
} from './toolRendering'

const props = defineProps<{
  call: GraphToolCall
  /** 工具中文名（sense.tools label；未命中回退原名） */
  label: string
  icon: string
  type: LiteToolType
  focused?: boolean
}>()

function statusLabel(status: GraphToolCall['status']): string {
  switch (status) {
    case 'pending':
      return '等待中'
    case 'accepted':
      return '执行中'
    case 'rejected':
      return '已拒绝'
    case 'error':
      return '出错'
    case 'completed':
      return '已完成'
  }
}

const argsValue = computed(() => parseJsonValue(props.call.arguments))
const argsEntries = computed(() => toObjectEntries(argsValue.value))
// 未知工具（other）无专用高亮字段：全部字段直接展开展示（已翻译中文标签），不折叠；
// 已知工具类型只高亮关键字段，其余收进「更多参数」折叠区。
const primaryArgs = computed(() => {
  const entries = argsEntries.value ?? []
  if (props.type === 'other') return entries
  return entries.filter((entry) => isPrimaryField(props.type, entry.key))
})
const secondaryArgs = computed(() => {
  if (props.type === 'other') return []
  return (argsEntries.value ?? []).filter((entry) => !isPrimaryField(props.type, entry.key))
})
const argsFallback = computed(() => {
  if (argsEntries.value) return ''
  const raw = props.call.arguments?.trim()
  return raw ? raw : ''
})

const resultValue = computed(() => parseJsonValue(props.call.result))
const resultEntries = computed(() => toObjectEntries(resultValue.value))
const primaryResult = computed(() => {
  const entries = resultEntries.value ?? []
  if (props.type === 'other') return entries
  return entries.filter((entry) => isPrimaryField(props.type, entry.key))
})
const secondaryResult = computed(() => {
  if (props.type === 'other') return []
  return (resultEntries.value ?? []).filter((entry) => !isPrimaryField(props.type, entry.key))
})
const resultText = computed(() => {
  if (resultEntries.value) return ''
  const raw = props.call.result?.trim()
  return raw ? raw : ''
})

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

const waiting = computed(() => props.call.status === 'pending' || props.call.status === 'accepted')
const readable = computed(() =>
  readableToolRun(
    props.call.name,
    props.label,
    props.type,
    props.call.status,
    props.call.arguments,
    props.call.result,
  ),
)
</script>

<template>
  <article class="lite-tool-call" :data-tooltype="type" :class="{ 'is-focused': focused }">
    <header class="lite-tool-call-head">
      <span class="lite-tool-call-icon" aria-hidden="true">{{ icon }}</span>
      <strong>{{ readable.toolLabel }}</strong>
      <span
        class="lite-tool-type-badge"
        :data-tooltype="type"
        :title="'工具类型：' + toolTypeLabel(type)"
      >
        <span class="lite-tool-type-dot" aria-hidden="true" />
        {{ toolTypeGlyph(type) }} {{ toolTypeLabel(type) }}
      </span>
      <span class="lite-tool-call-status" :data-status="call.status">{{
        statusLabel(call.status)
      }}</span>
      <!-- 工具调用的安全判定徽章（compact；缺省 = 未知） -->
      <RiskBadge :auth="call.security" compact />
    </header>

    <section class="lite-tool-story" aria-label="执行说明">
      <p class="lite-tool-story-intent">{{ readable.intent }}</p>
      <code v-if="readable.target" class="lite-tool-story-target">{{ readable.target }}</code>
      <p class="lite-tool-story-outcome">{{ readable.outcome }}</p>
      <p v-if="readable.resultSummary" class="lite-tool-story-result">
        {{ readable.resultSummary }}
      </p>
      <ul v-if="readable.changes.length" class="lite-tool-story-changes" aria-label="本次变更">
        <li v-for="change in readable.changes" :key="`${change.label}:${change.detail}`">
          <small>{{ change.label }}</small><span>{{ change.detail }}</span>
        </li>
      </ul>
    </section>

    <details class="lite-tool-call-args">
      <summary>查看完整参数</summary>
      <template v-if="argsEntries">
        <div
          v-for="entry in primaryArgs"
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
            <pre v-else class="lite-pre">{{ fieldText(entry) }}</pre>
          </div>
        </div>
        <details v-if="secondaryArgs.length" class="lite-fields-more">
          <summary>更多参数（{{ secondaryArgs.length }}）</summary>
          <div
            v-for="entry in secondaryArgs"
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
              <pre v-else class="lite-pre">{{ fieldText(entry) }}</pre>
            </div>
          </div>
        </details>
        <p v-if="!primaryArgs.length && !secondaryArgs.length" class="lite-drawer-hint is-muted">
          （无参数）
        </p>
      </template>
      <pre v-else-if="argsFallback" class="lite-pre">{{ argsFallback }}</pre>
      <p v-else class="lite-drawer-hint is-muted">（无参数）</p>
    </details>

    <details class="lite-tool-call-result">
      <summary>查看原始结果</summary>
      <template v-if="resultEntries">
        <div
          v-for="entry in primaryResult"
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
            <pre v-else class="lite-pre">{{ fieldText(entry) }}</pre>
          </div>
        </div>
        <details v-if="secondaryResult.length" class="lite-fields-more">
          <summary>更多（{{ secondaryResult.length }}）</summary>
          <div
            v-for="entry in secondaryResult"
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
              <pre v-else class="lite-pre">{{ fieldText(entry) }}</pre>
            </div>
          </div>
        </details>
        <p
          v-if="!primaryResult.length && !secondaryResult.length"
          class="lite-drawer-hint is-muted"
        >
          （无结果）
        </p>
      </template>
      <pre v-else-if="resultText" class="lite-pre">{{ resultText }}</pre>
      <p v-else class="lite-drawer-hint is-muted">{{ waiting ? '等待工具返回…' : '（无结果）' }}</p>
    </details>
  </article>
</template>

<style scoped>
.lite-tool-call {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 0;
  background: var(--el-fill-color-lighter);
}
.lite-tool-call.is-focused {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
.lite-tool-call-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.lite-tool-call-icon {
  font-size: 14px;
  line-height: 1;
}
.lite-tool-call-head strong {
  font-size: 12.5px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 强制字重规则：lite 内容一律 400。 */
  font-weight: 400;
}
.lite-tool-type-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border-radius: 0;
  font-size: 10.5px;
  line-height: 17px;
  border: 1px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.lite-tool-type-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.lite-tool-call[data-tooltype='exec'] .lite-tool-type-badge {
  border-color: color-mix(in srgb, #9b59b6 55%, var(--el-border-color));
  color: #9b59b6;
}
.lite-tool-call[data-tooltype='read'] .lite-tool-type-badge {
  border-color: color-mix(in srgb, #6b7f92 55%, var(--el-border-color));
  color: #6b7f92;
}
.lite-tool-call[data-tooltype='write'] .lite-tool-type-badge {
  border-color: color-mix(in srgb, #2f9e63 55%, var(--el-border-color));
  color: #2f9e63;
}
.lite-tool-call[data-tooltype='web'] .lite-tool-type-badge {
  border-color: color-mix(in srgb, #00a8a8 55%, var(--el-border-color));
  color: #00a8a8;
}
.lite-tool-call[data-tooltype='dispatch'] .lite-tool-type-badge {
  border-color: color-mix(in srgb, #e67e22 55%, var(--el-border-color));
  color: #e67e22;
}
.lite-tool-call[data-tooltype='other'] .lite-tool-type-badge {
  border-color: color-mix(in srgb, #c58a1f 55%, var(--el-border-color));
  color: #c58a1f;
}
.lite-tool-call-status {
  flex: none;
  font-size: 10.5px;
  color: var(--el-text-color-secondary);
  padding: 0 6px;
  border-radius: 0;
  border: 1px solid var(--el-border-color);
}
.lite-tool-call-status[data-status='accepted'],
.lite-tool-call-status[data-status='pending'] {
  color: var(--el-color-warning);
  border-color: color-mix(in srgb, var(--el-color-warning) 50%, var(--el-border-color));
}
.lite-tool-call-status[data-status='error'],
.lite-tool-call-status[data-status='rejected'] {
  color: var(--el-color-danger);
  border-color: color-mix(in srgb, var(--el-color-danger) 50%, var(--el-border-color));
}
.lite-tool-call-status[data-status='completed'] {
  color: var(--el-color-success);
  border-color: color-mix(in srgb, var(--el-color-success) 50%, var(--el-border-color));
}
.lite-tool-story {
  display: grid;
  gap: 4px;
  margin: 8px 0;
  padding: 8px 10px;
  border-left: 3px solid var(--el-color-primary);
  border-radius: 0;
  background: var(--el-fill-color-blank);
}
.lite-tool-story p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.lite-tool-story-intent {
  color: var(--el-text-color-primary);
}
.lite-tool-story-outcome {
  color: var(--el-text-color-secondary);
}
.lite-tool-story-result {
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  word-break: break-word;
}
.lite-tool-story-target {
  display: block;
  padding: 3px 6px;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 0;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-primary);
  font-family: var(--el-font-family-mono);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.lite-tool-story-changes {
  display: grid;
  gap: 4px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}
.lite-tool-story-changes li {
  display: grid;
  gap: 1px;
  padding-top: 4px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.lite-tool-story-changes small {
  color: var(--el-text-color-secondary);
  font-size: 10.5px;
}
.lite-tool-story-changes span {
  color: var(--el-text-color-primary);
  font-size: 11.5px;
  line-height: 1.5;
}
.lite-tool-call-args > summary,
.lite-tool-call-result > summary {
  cursor: pointer;
  list-style: none;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  user-select: none;
}
.lite-tool-call-args > summary:hover,
.lite-tool-call-result > summary:hover {
  color: var(--el-color-primary);
}
.lite-tool-call-args > summary::-webkit-details-marker,
.lite-tool-call-result > summary::-webkit-details-marker {
  display: none;
}
.lite-tool-call-args[open] > summary,
.lite-tool-call-result[open] > summary {
  margin-bottom: 6px;
}
.lite-tool-call-args,
.lite-tool-call-result {
  margin-top: 8px;
}
/* Preserves the field-level labels when a user explicitly inspects raw data. */
.lite-tool-call-args h5,
.lite-tool-call-result h5 {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.lite-tool-call-args,
.lite-tool-call-result {
  margin-top: 8px;
}
.lite-field {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 3px 0;
  min-width: 0;
}
.lite-field-key {
  flex: none;
  min-width: 64px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.lite-field-val {
  flex: 1;
  min-width: 0;
}
.lite-field-val > span {
  display: inline-block;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-primary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.lite-field-code {
  display: block;
  padding: 4px 8px;
  border-radius: 0;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  font-family: var(--el-font-family-mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-primary);
  max-height: 220px;
  overflow: auto;
  scrollbar-width: none;
}
.lite-fields-more {
  margin: 3px 0;
}
.lite-fields-more summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--el-color-primary);
  user-select: none;
}
.lite-fields-more summary:hover {
  text-decoration: underline;
}
.lite-pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 0;
  font-family: var(--el-font-family-mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-primary);
  max-height: 280px;
  overflow: auto;
  scrollbar-width: none;
}
.lite-drawer-hint {
  margin: 0;
  padding: 4px 2px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
