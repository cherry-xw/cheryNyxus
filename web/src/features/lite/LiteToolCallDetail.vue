<script setup lang="ts">
/**
 * LiteToolCallDetail：单条工具调用的结构化详情（问题 2：不同类型分开展示 + JSON 解析 + 英文→中文）。
 * - 外层卡片（.lite-tool-call / .is-focused）由 DetailDrawer 提供，本组件只渲染卡片内部；
 * - 参数 / 结果各自：解析 JSON → 按工具类型高亮关键字段（命令、路径、URL、任务说明…），
 *   嵌套对象 / 数组递归翻译键后 pretty-print；
 * - 解析失败回退原文 <pre>。
 */
import { computed, ref } from 'vue'
import { MorphIcon, type IconInput } from 'morphicons/vue'
import type { GraphToolCall, InteractionRecord } from '@/application/backend/public'
import type { LiteToolType } from './executionMonitor'
import {
  parseQuestionAnswer,
  parseQuestionArgs,
} from '@/features/agent/renderers/core/questionDisplay'
import RiskBadge from '@/components/RiskBadge.vue'
import ToolDescriptionDisclosure from '@/features/agent/renderers/ToolDescriptionDisclosure.vue'
import LiteFieldRows from './LiteFieldRows.vue'
import LiteInteractionView from './LiteInteractionView.vue'
import {
  detectSelectPattern,
  isPrimaryField,
  isSelectContextKey,
  isSelectPatternKey,
  parseJsonValue,
  toObjectEntries,
} from './toolRendering'

const props = defineProps<{
  call: GraphToolCall
  /** 工具中文名（sense.tools label；未命中回退内置中文映射） */
  label: string
  /** 工具类型回退图标（sense.tools 元信息未加载时使用；按类型配色） */
  icon: IconInput
  /** sense.tools 返回的工具图标；没有元信息时回退到按类型生成的图标。 */
  glyph?: string
  type: LiteToolType
  focused?: boolean
  windowId: string
  rootChatId: string
  /** 该调用对应的待处理交互（审批/提问）。存在时卡片渲染交互区（LiteInteractionView），
      交互完成后该值消失，卡片自动回到只读展示（v2026-11 交互入口迁入抽屉）。 */
  interaction?: InteractionRecord | null
  /** 结果尚有未取回内容时，展开结果会继续请求工具调用详情。 */
  resultHasMore?: boolean
  resultLoading?: boolean
}>()
const emit = defineEmits<{ expandResult: [] }>()

const argsValue = computed(() => parseJsonValue(props.call.arguments))
const argsEntries = computed(() => toObjectEntries(argsValue.value))
// 未知工具（other）无专用高亮字段：全部字段直接展开展示（已翻译中文标签）。
// 已知工具类型按工具字段顺序展示。
const primaryArgs = computed(() => {
  const entries = argsEntries.value ?? []
  if (props.type === 'other') return entries
  return entries.filter((entry) => isPrimaryField(props.type, entry.key))
})
const secondaryArgs = computed(() => {
  if (props.type === 'other') return []
  return (argsEntries.value ?? []).filter((entry) => !isPrimaryField(props.type, entry.key))
})
// 「问题 + 选项」形态参数（单选/多选）识别：命中后由专用区块展示，不再把 options 原文 JSON 列出。
const selectPattern = computed(() => detectSelectPattern(argsEntries.value))
// 选择类参数已由专用区块承载，从普通字段行排除；
// 选择类工具的标题/说明字段（header/rationale/nextStep）由参数上方的上下文块承载，同样排除。
const remainingArgs = computed(() => {
  if (!selectPattern.value) return primaryArgs.value
  return primaryArgs.value.filter(
    (entry) => !isSelectPatternKey(entry.key) && !isSelectContextKey(entry.key),
  )
})
const remainingSecondaryArgs = computed(() => {
  if (!selectPattern.value) return secondaryArgs.value
  return secondaryArgs.value.filter(
    (entry) => !isSelectPatternKey(entry.key) && !isSelectContextKey(entry.key),
  )
})
const visibleArgs = computed(() => [...remainingArgs.value, ...remainingSecondaryArgs.value])
// 提问工具：结构化参数（问题/选项/标题）与答案（已答/取消/等待）。答案由后端序列化为
// 「用户回答: <label>（补充: <note>）, 其他: <text>」（src/db/question.ts），直接渲染进选项。
const questionArgs = computed(() => parseQuestionArgs(props.call.arguments))
const answer = computed(() =>
  parseQuestionAnswer(props.call.result, props.call.status, questionArgs.value),
)
const questionWaiting = computed(
  () => props.call.status === 'pending' || props.call.status === 'accepted',
)
function isSelectedOption(label: string): boolean {
  return answer.value.kind === 'answered' && answer.value.labels.includes(label)
}
const argsFallback = computed(() => {
  if (argsEntries.value) return ''
  const raw = props.call.arguments?.trim()
  return raw ? raw : ''
})
const argsCount = computed(() => {
  if (argsEntries.value) return argsEntries.value.length
  return argsFallback.value ? 1 : 0
})

const waiting = computed(() => props.call.status === 'pending' || props.call.status === 'accepted')
// 结果区：默认只显示摘要；点击正文后请求并展示完整结果，也可再次点击收回摘要。
const resultExpanded = ref(false)
function toggleResult(): void {
  if (resultExpanded.value) {
    resultExpanded.value = false
    return
  }
  if (props.resultLoading) return
  resultExpanded.value = true
  if (props.resultHasMore) emit('expandResult')
}
function onResultPreviewKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  toggleResult()
}
const resultRaw = computed(() => props.call.result?.trim() ?? '')
const resultPreview = computed(() => {
  const compact = resultRaw.value.replace(/\s+/g, ' ').trim()
  const limit = 180
  if (compact.length <= limit) return compact
  return `${compact.slice(0, limit - 3).trimEnd()}...`
})
const resultDisplay = computed(() => (resultExpanded.value ? resultRaw.value : resultPreview.value))
</script>

<template>
  <article class="lite-tool-call" :data-tooltype="type" :class="{ 'is-focused': focused }">
    <header class="lite-tool-call-head">
      <span class="lite-tool-call-icon" aria-hidden="true">
        <span v-if="glyph" class="lite-tool-call-glyph">{{ glyph }}</span>
        <MorphIcon
          v-else
          :icon="icon"
          :size="16"
          :stroke-width="2"
          :reduced-motion="'always'"
          spring="snappy"
        />
      </span>
      <ToolDescriptionDisclosure
        class="lite-tool-call-name"
        :tool-name="label"
        :tool-key="call.name"
        :chat-id="rootChatId"
      />
      <!-- 工具调用的安全判定徽章（compact；缺省 = 未知）。
           标题 / 工具类型 / 执行状态已由抽屉顶部标题栏承担，此处不再重复展示（用户需求 2026-11）。 -->
      <RiskBadge :auth="call.security" compact />
    </header>

    <!-- 有待处理交互（审批/提问）：渲染交互区，代替下方只读展示；
         交互完成后 interaction 消失，卡片自动回到只读内容（v2026-11 交互入口迁入抽屉）。 -->
    <LiteInteractionView
      v-if="interaction"
      :window-id="windowId"
      :root-chat-id="rootChatId"
      :interaction="interaction"
      :question-id="call.callId"
    />

    <template v-else>
      <details class="lite-tool-call-args">
        <summary>
          <span>参数</span>
          <span class="lite-tool-call-count">（{{ argsCount }}）</span>
        </summary>
        <template v-if="argsEntries">
          <!-- 单选 / 多选形态参数：标题（header，本次问题内容）+ 问题 + 选项（已答时结果直接渲染进选项） -->
          <div v-if="selectPattern" class="lite-select-block">
            <p v-if="questionArgs?.header" class="lite-select-header">{{ questionArgs.header }}</p>
            <p class="lite-select-question">{{ selectPattern.question }}</p>
            <span class="lite-select-kind">{{ selectPattern.multi ? '可多选' : '单选' }}</span>
            <p v-if="answer.kind === 'cancelled'" class="lite-question-note">用户已取消该问题。</p>
            <p v-else-if="questionWaiting" class="lite-question-note">等待用户回答…</p>
            <p v-else-if="answer.kind === 'missing'" class="lite-question-note">
              这次执行没有留下可识别的回答。
            </p>
            <ul class="lite-select-options">
              <li
                v-for="option in selectPattern.options"
                :key="option.label"
                class="lite-select-option"
                :class="{ 'is-selected': isSelectedOption(option.label) }"
              >
                <span class="lite-select-mark" aria-hidden="true">{{
                  isSelectedOption(option.label) ? '✓' : selectPattern.multi ? '□' : '○'
                }}</span>
                <span class="lite-select-copy">
                  <span class="lite-select-label">{{ option.label }}</span>
                  <small v-if="option.description" class="lite-select-desc">{{
                    option.description
                  }}</small>
                  <small
                    v-if="answer.kind === 'answered' && answer.notes?.[option.label]"
                    class="lite-select-note"
                    >{{ answer.notes[option.label] }}</small
                  >
                </span>
              </li>
              <li
                v-if="answer.kind === 'answered' && answer.freeText"
                class="lite-select-option is-user-input"
              >
                <span class="lite-select-mark" aria-hidden="true">✓</span>
                <span class="lite-select-copy">
                  <span class="lite-select-label">其他</span>
                  <small class="lite-select-desc">{{ answer.freeText }}</small>
                </span>
              </li>
            </ul>
          </div>
          <LiteFieldRows :entries="visibleArgs" />
          <p v-if="!visibleArgs.length && !selectPattern" class="lite-drawer-hint is-muted">
            （无参数）
          </p>
        </template>
        <pre v-else-if="argsFallback" class="lite-pre">{{ argsFallback }}</pre>
        <p v-else class="lite-drawer-hint is-muted">（无参数）</p>
      </details>

      <!-- 结果区：提问工具已把结果渲染进选项，不再单列结果 -->
      <template v-if="!selectPattern">
        <section class="lite-tool-call-result">
          <h5>执行结果</h5>
          <div
            v-if="resultDisplay"
            class="lite-result-content"
            role="button"
            tabindex="0"
            aria-label="点击切换执行结果显示范围"
            :aria-expanded="resultExpanded"
            :aria-busy="resultLoading"
            @click="toggleResult"
            @keydown="onResultPreviewKeydown"
          >
            {{ resultDisplay }}
          </div>
          <p v-else class="lite-drawer-hint is-muted">
            {{ waiting ? '等待工具返回…' : '（无结果）' }}
          </p>
        </section>
      </template>
    </template>
  </article>
</template>

<style scoped>
.lite-tool-call {
  margin-bottom: 12px;
  padding: 12px 14px;
  border-radius: 0;
}
.lite-tool-call + .lite-tool-call {
  padding-top: 13px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.lite-tool-call-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.lite-tool-call-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--el-text-color-regular);
  line-height: 1;
}
.lite-tool-call-glyph {
  font-size: 16px;
  line-height: 1;
}
/* 工具 icon 按类型配色（与列表 cluster 同色板），名称撑开剩余空间、安全徽章靠右。 */
.lite-tool-call[data-tooltype='exec'] .lite-tool-call-icon {
  color: #9b59b6;
}
.lite-tool-call[data-tooltype='read'] .lite-tool-call-icon {
  color: #6b7f92;
}
.lite-tool-call[data-tooltype='write'] .lite-tool-call-icon {
  color: #2f9e63;
}
.lite-tool-call[data-tooltype='web'] .lite-tool-call-icon {
  color: #00a8a8;
}
.lite-tool-call[data-tooltype='dispatch'] .lite-tool-call-icon {
  color: #e67e22;
}
.lite-tool-call[data-tooltype='other'] .lite-tool-call-icon {
  color: #c58a1f;
}
.lite-tool-call-name {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 400;
  color: var(--el-text-color-primary);
}
/* 工具名称 = ToolDescriptionDisclosure 触发按钮（共享组件内部已处理长名省略）。 */
/* 工具类型 / 执行状态 tag 已由抽屉顶部标题栏承担，工具卡头部仅保留图标 + 名称 + 风险徽章。
   共享 RiskBadge（compact）拉齐到同套 tag 尺寸（圆角随 RiskBadge 基样式）。 */
.lite-tool-call-head :deep(.risk-badge) {
  flex: none;
  display: inline-flex;
  align-items: center;
  line-height: 1;
}
.lite-tool-call-head :deep(.risk-chip) {
  height: 20px;
  box-sizing: border-box;
  padding: 0 8px;
  font-size: 14px;
  line-height: 20px;
  border-radius: 999px;
}
.lite-tool-call-head :deep(.risk-dot) {
  width: 7px;
  height: 7px;
}
.lite-tool-call-args > summary {
  display: flex;
  align-items: baseline;
  gap: 2px;
  cursor: pointer;
  list-style: none;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  user-select: none;
}
.lite-tool-call-args > summary:hover {
  color: var(--el-color-primary);
}
.lite-tool-call-args > summary::-webkit-details-marker {
  display: none;
}
.lite-tool-call-args > summary::before {
  content: '▸';
  flex: none;
  margin-right: 3px;
  font-size: 12px;
  transition: transform 140ms ease;
}
.lite-tool-call-args[open] > summary::before {
  transform: rotate(90deg);
}
.lite-tool-call-args[open] > summary {
  margin-bottom: 8px;
}
.lite-tool-call-count {
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}
.lite-result-content {
  display: block;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  cursor: pointer;
}
.lite-result-content:hover,
.lite-result-content:focus-visible {
  color: color-mix(in srgb, var(--el-text-color-regular) 88%, var(--el-text-color-primary));
  outline: none;
}
.lite-tool-call-args,
.lite-tool-call-result {
  margin-top: 10px;
}
/* Preserves the field-level labels when a user explicitly inspects raw data. */
.lite-tool-call-args h5,
.lite-tool-call-result h5 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
/* 单选 / 多选形态参数：标题（header）+ 问题 + 选项列表区块。 */
.lite-select-block {
  margin: 0 0 8px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 0;
  background: var(--el-fill-color-blank);
}
.lite-select-header {
  margin: 0 0 4px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.lite-select-question {
  margin: 0 0 4px;
  color: var(--el-text-color-primary);
  font-size: 16px;
  line-height: 1.55;
}
.lite-select-kind {
  display: inline-block;
  margin-bottom: 6px;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 45%, var(--el-border-color));
  border-radius: 0;
  color: var(--el-color-primary);
  font-size: 14px;
  line-height: 18px;
}
.lite-select-options {
  display: grid;
  gap: 3px;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
}
.lite-select-option {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: start;
  gap: 7px;
  min-width: 0;
  padding: 3px 4px;
}
.lite-select-option.is-selected {
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
}
.lite-select-option.is-selected .lite-select-mark,
.lite-select-option.is-selected .lite-select-label {
  color: var(--el-color-primary);
}
.lite-select-option.is-user-input .lite-select-label,
.lite-select-option.is-user-input .lite-select-desc {
  color: var(--el-color-primary);
}
.lite-select-mark {
  margin-top: 2px;
  width: 16px;
  color: var(--el-text-color-secondary);
  font-size: 15px;
  line-height: 1.5;
  text-align: center;
}
.lite-select-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.lite-select-label {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-size: 16px;
  line-height: 1.5;
  word-break: break-word;
}
/* 选项说明：完整展示在选项文字下方（浅色），不截断。 */
.lite-select-desc {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.lite-select-note {
  margin-top: 2px;
  padding-left: 5px;
  border-left: 2px solid color-mix(in srgb, var(--el-color-primary) 50%, transparent);
  color: var(--el-color-primary);
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.lite-question-note {
  margin: 6px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.lite-fields-more {
  margin: 4px 0;
}
.lite-fields-more summary {
  cursor: pointer;
  font-size: 14px;
  color: var(--el-color-primary);
  user-select: none;
}
.lite-fields-more summary:hover {
  text-decoration: underline;
}
/* 解析失败回退原文（字段行样式在 LiteFieldRows）。允许任意位置断点换行（break-all）。 */
.lite-pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 0;
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--el-text-color-primary);
  max-height: 280px;
  overflow: auto;
  scrollbar-width: none;
}
.lite-drawer-hint {
  margin: 0;
  padding: 4px 2px;
  color: var(--el-text-color-secondary);
  font-size: 15px;
}
</style>
