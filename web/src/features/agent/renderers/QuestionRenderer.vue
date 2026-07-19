<script setup lang="ts">
/**
 * QuestionRenderer：ask_user_question 历史只读渲染器。
 *
 * 视觉沿用 QuestionCard（紫色系 #7c3aed）：
 * - header 行：indicator + 可选 header + 右侧 AnswerBadge（已回答/已取消/等待中/超时）
 * - question 正文（pre-wrap）
 * - options chip 行：按 result 字符串反推用户选择，命中 chip 加 .selected 样式
 *
 * 数据来源：
 * - args: JSON 字符串 `{ question, header?, options:[{label,description?}], multiSelect }`（后端契约 types.ts:192）
 * - result: `"用户回答: <label>"` | `"用户回答: <l1>, <l2>"` | `"用户回答: 其他: <text>"` | `"(用户取消了此问题)"`（ask.ts:45-48）
 *
 * 不处理交互（历史只读），不修改 store 状态（符合 RendererProps 契约）。
 */
import { computed } from 'vue'
import type { RendererProps } from './types'
import type { SenseCallRecord } from '@/stores/agents'

interface Option {
  label: string
  description?: string
}

interface Args {
  question: string
  header?: string
  options: Option[]
  multiSelect?: boolean
}

/** call.args 解析（后端契约：JSON 字符串；防御性兼容对象）。 */
function parseArgs(call: SenseCallRecord): Args | null {
  try {
    const raw = typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {})
    const obj = JSON.parse(raw) as Partial<Args>
    if (typeof obj.question !== 'string' || !Array.isArray(obj.options)) return null
    return {
      question: obj.question,
      header: typeof obj.header === 'string' ? obj.header : undefined,
      options: obj.options.filter((o): o is Option => typeof o?.label === 'string'),
      multiSelect: obj.multiSelect === true,
    }
  } catch (e) {
    console.warn('[QuestionRenderer] args 解析失败', e)
    return null
  }
}

const props = defineProps<RendererProps>()

const args = computed(() => parseArgs(props.call))

type AnswerState =
  | { kind: 'running' }
  | { kind: 'cancelled' }
  | { kind: 'missing' }
  | { kind: 'other'; text: string }
  | { kind: 'labels'; labels: string[] }

/** 从 result 字符串反推答案状态（匹配 ask.ts:45-48 的三种返回格式）。 */
const answerState = computed<AnswerState>(() => {
  if (props.call.status === 'running') return { kind: 'running' }
  const r = props.call.result
  if (typeof r !== 'string') return { kind: 'missing' }
  if (r === '(用户取消了此问题)') return { kind: 'cancelled' }
  const prefix = '用户回答: '
  if (!r.startsWith(prefix)) return { kind: 'missing' }
  const body = r.slice(prefix.length)
  if (body.startsWith('其他: ')) return { kind: 'other', text: body.slice(4) }
  // 单选/多选用 ", " 拆分；注意：label 内若含逗号会误拆，ask.ts 后端未转义，此处保持与后端一致的解析
  const labels = body
    .split(', ')
    .map((s) => s.trim())
    .filter(Boolean)
  return { kind: 'labels', labels }
})

/** 当前 chip 是否高亮为"用户选中"。 */
function isSelected(label: string): boolean {
  const s = answerState.value
  if (s.kind === 'labels') return s.labels.includes(label)
  if (s.kind === 'other') return label === '其他'
  return false
}

/** header 右侧 AnswerBadge 文案 + 样式类。 */
const answerBadge = computed<{ text: string; cls: string }>(() => {
  const s = answerState.value
  switch (s.kind) {
    case 'running':
      return { text: '等待中…', cls: 'badge-running' }
    case 'cancelled':
      return { text: '已取消', cls: 'badge-cancelled' }
    case 'missing':
      return { text: '无回答', cls: 'badge-missing' }
    case 'other':
      return { text: `已回答 · 其他: ${s.text}`, cls: 'badge-answered' }
    case 'labels':
      return { text: `已回答 · ${s.labels.join(', ')}`, cls: 'badge-answered' }
  }
})
</script>

<template>
  <div class="question-renderer">
    <div class="q-head">
      <span class="indicator" aria-hidden="true" />
      <span v-if="args?.header" class="q-header">{{ args.header }}</span>
      <span class="q-badge" :class="answerBadge.cls">{{ answerBadge.text }}</span>
    </div>
    <div v-if="args" class="q-text">{{ args.question }}</div>
    <div v-if="args && args.options.length > 0" class="q-options">
      <span
        v-for="opt in args.options"
        :key="opt.label"
        class="q-chip"
        :class="{ selected: isSelected(opt.label) }"
        :title="opt.description ?? opt.label"
      >
        <span v-if="isSelected(opt.label)" class="check" aria-hidden="true">✓</span>
        {{ opt.label }}
      </span>
    </div>
    <!-- 解析失败降级：显示原始 result -->
    <pre v-if="!args" class="q-fallback">{{ call.result ?? '(无数据)' }}</pre>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.question-renderer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgba(124, 58, 237, 0.28);
  border-radius: 8px;
  background: rgba(245, 243, 255, 0.6);
  min-width: 180px;
  max-width: 420px;
}

.q-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .indicator {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #7c3aed;
    box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.18);
  }

  .q-header {
    color: fade(@ink, 80%);
    font-size: 10px;
    font-weight: 800;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .q-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &.badge-answered {
      background: rgba(124, 58, 237, 0.14);
      color: #5b21b6;
    }
    &.badge-cancelled {
      background: rgba(107, 114, 128, 0.14);
      color: #4b5563;
    }
    &.badge-running {
      background: rgba(234, 179, 8, 0.16);
      color: #a16207;
      animation: q-pulse 1.1s ease-in-out infinite;
    }
    &.badge-missing {
      background: rgba(239, 68, 68, 0.12);
      color: #b91c1c;
    }
  }
}

.q-text {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
  color: fade(@ink, 88%);
  white-space: pre-wrap;
  word-break: break-word;
}

.q-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.q-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  color: fade(@ink, 78%);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.2;

  &.selected {
    background: rgba(124, 58, 237, 0.14);
    border-color: rgba(124, 58, 237, 0.55);
    color: #5b21b6;

    .check {
      font-weight: 800;
      color: #6d28d9;
    }
  }

  .check {
    font-size: 9px;
  }
}

.q-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.06);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  color: fade(@ink, 66%);
}

@keyframes q-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
</style>
