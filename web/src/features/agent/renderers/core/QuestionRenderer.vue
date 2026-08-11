<script setup lang="ts">
/**
 * QuestionRenderer：ask_user_question 历史只读渲染器。
 *
 * 视觉沿用 QuestionCard（紫色系 #7c3aed）：
 * - header 行：indicator + 可选 header + 右侧 AnswerBadge（已回答/已取消/等待中/超时）
 * - question 正文（pre-wrap）
 * - 选项列表：单选使用圆形标记，多选使用方形标记，已选项显示勾选态
 * - 自由文本：将“其他”回答与已选项分开展示
 *
 * 数据来源：
 * - args: JSON 字符串 `{ question, header?, options:[{label,description?}], multiSelect }`（后端契约 types.ts:192）
 * - result: `"用户回答: <label>"` | `"用户回答: <l1>, <l2>"` | `"用户回答: 其他: <text>"` | `"(用户取消了此问题)"`（ask.ts:45-48）
 *
 * 不处理交互（历史只读），不修改 store 状态（符合 RendererProps 契约）。
 */
import { computed } from 'vue'
import type { RendererProps } from '../types'
import { parseQuestionAnswer, parseQuestionArgs } from './questionDisplay'

const props = defineProps<RendererProps>()

const args = computed(() => parseQuestionArgs(props.call.args))
const answerState = computed(() =>
  parseQuestionAnswer(props.call.result, props.call.status, args.value),
)

/** 当前 chip 是否高亮为"用户选中"。 */
function isSelected(label: string): boolean {
  return answerState.value.kind === 'answered' && answerState.value.labels.includes(label)
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
    case 'answered':
      return { text: '已回答', cls: 'badge-answered' }
  }
  return { text: '状态未知', cls: 'badge-missing' }
})
</script>

<template>
  <div class="question-renderer">
    <div class="q-head">
      <span class="indicator" aria-hidden="true" />
      <span v-if="args?.header" class="q-header">{{ args.header }}</span>
      <span v-if="args" class="q-kind">{{ args.multiSelect ? '多选' : '单选' }}</span>
      <span class="q-badge" :class="answerBadge.cls">{{ answerBadge.text }}</span>
    </div>
    <div v-if="args" class="q-text">{{ args.question }}</div>
    <div
      v-if="args && args.options.length > 0"
      class="q-options"
      role="list"
      :aria-label="args.multiSelect ? '多选选项' : '单选选项'"
    >
      <div
        v-for="opt in args.options"
        :key="opt.label"
        class="q-option"
        :class="{ selected: isSelected(opt.label) }"
        role="listitem"
      >
        <span class="q-control" :class="{ 'is-multi': args.multiSelect }" aria-hidden="true">
          {{ isSelected(opt.label) ? '✓' : '' }}
        </span>
        <span class="q-option-copy">
          <strong>{{ opt.label }}</strong>
          <small v-if="opt.description">{{ opt.description }}</small>
        </span>
      </div>
    </div>
    <div v-if="answerState.kind === 'answered' && answerState.freeText" class="q-other-answer">
      <small>其他补充</small>
      <p>{{ answerState.freeText }}</p>
    </div>
    <!-- 解析失败降级：显示原始 result -->
    <pre v-if="!args" class="q-fallback">{{ call.result ?? '(无数据)' }}</pre>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.question-renderer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgba(124, 58, 237, 0.28);
  border-radius: 8px;
  // 紫色系容器：随主题深浅翻转（深色下若用固定浅紫 rgba(245,243,255,.6) 会过亮）
  background: color-mix(in srgb, #7c3aed 12%, var(--surface));
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
    color: color-mix(in srgb, var(--ink) 80%, transparent);
    font-size: 10px;
    font-weight: 800;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .q-kind {
    flex-shrink: 0;
    padding: 1px 5px;
    border: 1px solid rgba(124, 58, 237, 0.2);
    border-radius: 4px;
    color: var(--violet);
    font-size: 9px;
    font-weight: 800;
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
      color: var(--violet);
    }
    &.badge-cancelled {
      background: color-mix(in srgb, var(--info) 14%, transparent);
      color: var(--info);
    }
    &.badge-running {
      background: color-mix(in srgb, var(--warning) 16%, transparent);
      color: var(--warning);
      animation: q-pulse 1.1s ease-in-out infinite;
    }
    &.badge-missing {
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      color: var(--danger);
    }
  }
}

.q-text {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  white-space: pre-wrap;
  word-break: break-word;
}

.q-options {
  display: grid;
  gap: 4px;
}

.q-option {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: start;
  gap: 6px;
  padding: 6px 7px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 10.5px;
  line-height: 1.3;

  &.selected {
    background: var(--violet-soft);
    border-color: color-mix(in srgb, var(--violet) 45%, transparent);
    color: var(--violet);
  }
}

.q-control {
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
  margin-top: 1px;
  border: 1px solid rgba(124, 58, 237, 0.5);
  border-radius: 50%;
  color: var(--violet);
  font-weight: 900;
  line-height: 1;

  &.is-multi {
    border-radius: 2px;
  }
}

.q-option-copy {
  min-width: 0;
  display: grid;
  gap: 2px;

  strong {
    overflow-wrap: anywhere;
    font-weight: 750;
  }

  small {
    color: color-mix(in srgb, var(--ink) 58%, transparent);
    font-size: 9.5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

.q-other-answer {
  padding: 6px 7px;
  border-left: 2px solid rgba(124, 58, 237, 0.55);
  background: rgba(124, 58, 237, 0.08);

  small {
    display: block;
    margin-bottom: 3px;
    color: var(--violet);
    font-weight: 800;
  }

  p {
    margin: 0;
    color: color-mix(in srgb, var(--ink) 82%, transparent);
    font-size: 10.5px;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

.q-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
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
