<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElTooltip } from 'element-plus'
import ApprovalCard from '@/features/agent/cards/ApprovalCard.vue'
import QuestionCard from '@/features/agent/cards/QuestionCard.vue'
import { splitCommandPrompt } from '@/features/agent/composables/commands'
import {
  parseQuestionAnswer,
  parseQuestionArgs,
} from '@/features/agent/renderers/core/questionDisplay'
import { useAgentsStore } from '@/stores'
import type { ApprovalState } from '@/stores/agents'
import { renderMarkdown } from '@/utils/markdown'
import { formatTime } from '@/utils/formatTime'
import type { ExecutionEdge, ExecutionNode } from '../graph/executionGraph'
import { skinForNode } from '../graph/nodeSkins'
import type { NodePopoverQuestion } from '../graph/nodePopoverModel'
import { selectedToolCall, toolBatchDetail, toolBatchUsesTabs } from '../graph/toolBatchDetails'
import { terminationDisplay } from '../graph/termination'

const RESULT_PREVIEW_LIMIT = 20_000
const DESCRIPTION_KEYS = ['description', 'explanation'] as const
const INSTRUCTION_KEYS = ['task', 'prompt', 'query', 'instruction', 'command'] as const
const FIELD_LABELS: Record<string, string> = {
  description: '说明',
  explanation: '说明',
  task: '任务',
  prompt: '提示词',
  query: '查询',
  instruction: '指令',
  command: '命令',
  path: '路径',
  url: '地址',
  content: '内容',
  offset: '起始行',
  limit: '行数限制',
  compression: '压缩方式',
}
const STATUS_LABELS: Record<string, string> = {
  active: '执行中',
  accepted: '执行中',
  pending: '等待中',
  completed: '已完成',
  error: '执行失败',
  rejected: '已拒绝',
  revoked: '已撤回',
  transient: '准备中',
  editing: '编辑中',
  consuming: '处理中',
}
const WAKE_LABELS: Record<string, string> = {
  immediate: '完成后立即继续',
  deferred: '后台暂存结果',
  barrier: '全部完成后继续',
}
const SPAWN_TOOL_NAMES = new Set(['spawn_role', 'spawn_agent'])

type FieldKind = 'command' | 'path' | 'url' | 'structured' | 'scalar' | 'multiline' | 'text'
interface FieldView {
  key: string
  label: string
  value: string
  kind: FieldKind
}
interface SearchResultItem {
  filePath: string
  line?: number
  content?: string
  gitStatus?: string
}
interface SearchResultView {
  summary: string
  items: SearchResultItem[]
}
interface SkillResultView {
  name: string
  content: string
  lineCount: number
  error: string
}

const props = defineProps<{
  node: ExecutionNode
  foldNode?: ExecutionNode
  relatedEdges: ExecutionEdge[]
  pinned: boolean
  maxHeight: number
  selectedCallId?: string
  chatId?: string
  approval?: ApprovalState
  question?: NodePopoverQuestion
  detailBranchAvailable?: boolean
  detailBranchUnavailableReason?: string
}>()
const emit = defineEmits<{
  close: []
  selectCall: [callId: string]
  branch: [type: 'detail' | 'continuation', nodeId: string]
}>()
const agents = useAgentsStore()
const batch = computed(() => toolBatchDetail(props.node))
const copiedFieldKey = ref('')
const nodeTermination = computed(() =>
  props.node.sourceFact?.termination
    ? terminationDisplay(props.node.sourceFact.termination)
    : undefined,
)
const foldPosition = computed(() => {
  const members = props.foldNode?.fold?.members ?? []
  const index = members.findIndex(
    (member) =>
      member.displayNode.id === props.node.id ||
      member.nodes.some((node) => node.id === props.node.id),
  )
  return index >= 0 ? { index: index + 1, total: members.length } : undefined
})
const batchInfo = computed(() => {
  const current = props.question
  if (!current) return null
  return {
    batchId: current.batch.batchId,
    total: current.batch.questions.length,
    readyCount: current.batch.questions.filter((question) => question.localStatus === 'ready')
      .length,
    currentIndex: current.currentIndex,
    isLast: current.currentIndex === current.batch.questions.length - 1,
  }
})

watch(
  () => batch.value?.calls.map((call) => call.callId),
  (ids) => {
    if (ids?.includes(props.selectedCallId ?? '')) return
    const fallback = selectedToolCall(batch.value?.calls ?? [], props.selectedCallId)
    if (fallback) emit('selectCall', fallback.callId)
  },
  { immediate: true },
)

const selectedCall = computed(() =>
  selectedToolCall(batch.value?.calls ?? [], props.selectedCallId),
)
const toolMeta = computed(() => {
  const name = selectedCall.value?.name
  return name ? agents.senseTools.find((tool) => tool.name === name) : undefined
})
const toolIcon = computed(() => toolMeta.value?.icon || '⚙')
const toolName = computed(() => toolMeta.value?.label?.trim() || '工具')
const selectedStatus = computed(() =>
  selectedCall.value ? statusLabel(selectedCall.value.status) : statusLabel(batch.value?.status),
)
const parsedArguments = computed(() => parseRecord(selectedCall.value?.arguments))
const isSpawnTool = computed(() => SPAWN_TOOL_NAMES.has(selectedCall.value?.name ?? ''))
const isReadFileTool = computed(() => selectedCall.value?.name === 'read_file')
const isQuestionTool = computed(() => selectedCall.value?.name === 'ask_user_question')
const isSearchTool = computed(() => selectedCall.value?.name === 'search_codebase')
const isSkillTool = computed(() => selectedCall.value?.name === 'skill')
const questionArgs = computed(() =>
  isQuestionTool.value ? parseQuestionArgs(selectedCall.value?.arguments) : null,
)
const questionAnswer = computed(() =>
  parseQuestionAnswer(
    selectedCall.value?.result,
    selectedCall.value?.status === 'pending' || selectedCall.value?.status === 'accepted'
      ? 'running'
      : 'done',
    questionArgs.value,
  ),
)
const readFilePath = computed(() => displayValue(parsedArguments.value.path))
const readFileRange = computed(() => {
  const offset = parsedArguments.value.offset
  const limit = parsedArguments.value.limit
  if (offset === undefined && limit === undefined) return '全文'
  const start = typeof offset === 'number' ? `第 ${offset} 行起` : '从文件开头'
  return typeof limit === 'number' ? `${start}，最多 ${limit} 行` : `${start}至文件末尾`
})
const readFileContent = computed(() =>
  (selectedCall.value?.result ?? '').replace(/\[(compressed|truncated):\s*\w+\]\s*$/, '').trimEnd(),
)
const readFilePreview = computed(() =>
  readFileContent.value.length > RESULT_PREVIEW_LIMIT
    ? readFileContent.value.slice(0, RESULT_PREVIEW_LIMIT)
    : readFileContent.value,
)
const readFileLineCount = computed(() =>
  readFilePreview.value ? readFilePreview.value.split(/\r?\n/).length : 0,
)
const searchMode = computed(() =>
  parsedArguments.value.mode === 'filename' ? '文件名搜索' : '内容搜索',
)
const searchQuery = computed(() => displayValue(parsedArguments.value.query))
const searchPath = computed(() => displayValue(parsedArguments.value.path))
const searchConfiguration = computed(() => {
  const values = [`最多 ${numberArgument('maxResults', 50)} 项`]
  if (parsedArguments.value.mode !== 'filename') {
    values.unshift(parsedArguments.value.regex === true ? '正则匹配' : '普通文本')
    values.push(`上下文 ${numberArgument('contextLines', 0)} 行`)
  }
  return values
})
const searchResult = computed(() => parseSearchResult(selectedCall.value?.result ?? ''))
const skillResult = computed(() =>
  parseSkillResult(
    selectedCall.value?.result ?? '',
    displayValue(parsedArguments.value.name),
  ),
)
const spawnRole = computed(() => displayValue(parsedArguments.value.type))
const spawnPrompt = computed(() => displayValue(parsedArguments.value.prompt))
const spawnWake = computed(() => {
  const wake = displayValue(parsedArguments.value.wake) || 'immediate'
  return WAKE_LABELS[wake] ?? wake
})
const actualDescription = computed(() => {
  const key = DESCRIPTION_KEYS.find((candidate) => parsedArguments.value[candidate] != null)
  return key ? displayValue(parsedArguments.value[key]) : ''
})
const primaryInstruction = computed<FieldView | undefined>(() => {
  const key = INSTRUCTION_KEYS.find((candidate) => parsedArguments.value[candidate] != null)
  return key ? fieldView(key, parsedArguments.value[key]) : undefined
})
const secondaryFields = computed(() =>
  Object.entries(parsedArguments.value)
    .filter(
      ([key]) =>
        !DESCRIPTION_KEYS.includes(key as (typeof DESCRIPTION_KEYS)[number]) &&
        key !== primaryInstruction.value?.key,
    )
    .slice(0, 12)
    .map(([key, value]) => fieldView(key, value)),
)
const renderedResult = computed(() => {
  const result = selectedCall.value?.result ?? ''
  const preview =
    result.length > RESULT_PREVIEW_LIMIT
      ? `${result.slice(0, RESULT_PREVIEW_LIMIT)}\n\n> 结果内容较长，当前仅展示前半部分。复制仍会包含完整结果。`
      : result
  return renderMarkdown(preview)
})
const resultTruncated = computed(
  () => (selectedCall.value?.result?.length ?? 0) > RESULT_PREVIEW_LIMIT,
)
const parsedNodeContent = computed(() => parseRecord(props.node.content))
const nodeDescription = computed(() => {
  const key = DESCRIPTION_KEYS.find((candidate) => parsedNodeContent.value[candidate] != null)
  return key ? displayValue(parsedNodeContent.value[key]) : ''
})
const nodeContent = computed(() => {
  if (!Object.keys(parsedNodeContent.value).length) return props.node.content
  const rest = Object.fromEntries(
    Object.entries(parsedNodeContent.value).filter(
      ([key]) => !DESCRIPTION_KEYS.includes(key as (typeof DESCRIPTION_KEYS)[number]),
    ),
  )
  return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''
})
const isUserNode = computed(() => props.node.actor.kind === 'user')
const canBranch = computed(() => {
  const fact = props.node.sourceFact
  if (!fact || fact.status !== 'committed' || fact.kind === 'system') return false
  if (!fact.content.trim() && !fact.toolCalls?.length) return false
  return !(fact.toolCalls ?? []).some((call) => call.status === 'pending' || call.status === 'accepted')
})
const nodeContentSegments = computed(() => splitCommandPrompt(nodeContent.value || ''))
const renderedNodeContent = computed(() => renderMarkdown(nodeContent.value || ''))
/** 持久图投影已把同源 message 的 thinking 合并进 tool-batch。 */
const nodeThinking = computed(
  () => props.node.thinking?.trim() || props.node.sourceFact?.thinking?.trim() || '',
)
const thinkingOpen = ref(false)
watch(
  () => props.node.id,
  () => {
    thinkingOpen.value = false
  },
)
const nodeTitle = computed(() => {
  if (foldPosition.value) return `过程组 · ${foldPosition.value.index}/${foldPosition.value.total}`
  if (batch.value) {
    if (batch.value.calls.length === 1) return toolName.value
    return batch.value.calls.length ? `工具执行 · ${batch.value.calls.length} 项` : '工具执行'
  }
  if (props.node.direction === 'parent-to-child') return '委派任务'
  if (props.node.actor.kind === 'agent') {
    return (
      props.node.actor.roleType?.trim() ||
      (props.node.sourceChatId === props.node.rootChatId ? 'Cherry Nyxus' : '协作节点')
    )
  }
  if (props.node.actor.kind === 'user') return props.node.kind === 'input' ? '我的指令' : '我'
  return skinForNode(props.node).label
})
const nodeStatus = computed(() =>
  statusLabel(props.node.inputState ?? props.node.sourceFact?.status ?? props.node.status),
)
const nodeTime = computed(() => formatTime(props.node.createdAt))

function parseRecord(source?: string): Record<string, unknown> {
  if (!source) return {}
  try {
    const value: unknown = JSON.parse(source)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function statusLabel(status?: string): string {
  return status ? STATUS_LABELS[status] || '状态已更新' : '状态未知'
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] || '参数'
}

function fieldKind(key: string, value: unknown): FieldKind {
  if (key === 'command') return 'command'
  if (key === 'path') return 'path'
  if (key === 'url') return 'url'
  if (key === 'content' && typeof value === 'string') return 'multiline'
  if (Array.isArray(value) || (value && typeof value === 'object')) return 'structured'
  if (typeof value === 'number' || typeof value === 'boolean') return 'scalar'
  return 'text'
}

function isQuestionOptionSelected(label: string): boolean {
  return questionAnswer.value.kind === 'answered' && questionAnswer.value.labels.includes(label)
}

function numberArgument(key: string, fallback: number): number {
  const value = parsedArguments.value[key]
  return typeof value === 'number' ? value : fallback
}

function parseSearchResult(source: string): SearchResultView {
  const lines = source.split(/\r?\n/).filter((line) => line.trim())
  const firstLine = lines[0] ?? ''
  const hasSummary = /^(找到|未找到|错误：)/.test(firstLine)
  const items: SearchResultItem[] = []

  for (const line of hasSummary ? lines.slice(1) : lines) {
    const contentMatch = line.match(/^(.+?):(\d+):\s?(.*)$/)
    if (contentMatch?.[1] && contentMatch[2] !== undefined) {
      items.push({
        filePath: contentMatch[1],
        line: Number.parseInt(contentMatch[2], 10),
        content: contentMatch[3] ?? '',
      })
      continue
    }

    const fileMatch = line.match(/^(.*?)(?: \[([^\]]+)\])?$/)
    if (fileMatch?.[1]) {
      items.push({
        filePath: fileMatch[1],
        ...(fileMatch[2] ? { gitStatus: fileMatch[2] } : {}),
      })
    }
  }

  return { summary: hasSummary ? firstLine : '', items }
}

function parseSkillResult(source: string, fallbackName: string): SkillResultView {
  const raw = source.trim()
  if (!raw) return { name: fallbackName, content: '', lineCount: 0, error: '' }

  const missing = raw.match(/^Error: skill "([^"]+)" not found$/)
  if (missing?.[1]) {
    return {
      name: missing[1],
      content: '',
      lineCount: 0,
      error: `未找到技能“${missing[1]}”。`,
    }
  }

  const activated = raw.match(/^"([^"]+)"技能已激活[^\n]*\r?\n\r?\n([\s\S]*)$/)
  const content = (activated?.[2] ?? raw).trim()
  return {
    name: activated?.[1] ?? fallbackName,
    content,
    lineCount: content ? content.split(/\r?\n/).length : 0,
    error: raw.startsWith('Error:') ? raw : '',
  }
}

function fieldView(key: string, value: unknown): FieldView {
  return { key, label: fieldLabel(key), value: displayValue(value), kind: fieldKind(key, value) }
}

function isCopyableField(field: FieldView): boolean {
  return (
    field.kind === 'command' ||
    field.kind === 'path' ||
    field.kind === 'url' ||
    field.kind === 'multiline' ||
    ['task', 'prompt', 'query', 'instruction'].includes(field.key)
  )
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value, null, 2)
}

function toolLabel(name: string): string {
  return agents.senseTools.find((tool) => tool.name === name)?.label?.trim() || '工具'
}

function toolGlyph(name: string): string {
  return agents.senseTools.find((tool) => tool.name === name)?.icon || '⚙'
}

async function copyField(key: string, value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value)
    copiedFieldKey.value = key
  } catch {
    copiedFieldKey.value = `${key}:error`
  }
  window.setTimeout(() => {
    if (copiedFieldKey.value === key || copiedFieldKey.value === `${key}:error`) {
      copiedFieldKey.value = ''
    }
  }, 1200)
}
</script>

<template>
  <aside
    class="node-popover"
    :class="{ 'is-pinned': pinned, 'is-actionable': approval || question }"
    :style="{ maxHeight: `${maxHeight}px` }"
    role="dialog"
    :aria-label="`${nodeTitle}详情`"
  >
    <div class="popover-chrome">
      <header class="popover-head">
        <span class="title-icon" aria-hidden="true">
          {{ batch ? toolIcon : skinForNode(node).glyph }}
        </span>
        <strong>{{ nodeTitle }}</strong>
        <span v-if="nodeTime" class="node-time" aria-label="节点发起时间">{{ nodeTime }}</span>
        <span v-if="!batch" class="status-pill" :class="`status-${node.status}`">
          {{ nodeStatus }}
        </span>
        <div v-if="canBranch && !approval && !question" class="branch-head-actions" role="group" aria-label="从此节点发起对话">
          <span class="branch-action-wrap">
            <button
              type="button"
              class="branch-head-action is-detail"
              :disabled="detailBranchAvailable === false"
              @click="emit('branch', 'detail', node.sourceFact!.id)"
            ><span aria-hidden="true">◉</span>解释此处</button>
            <ElTooltip
              :content="detailBranchAvailable === false
                ? (detailBranchUnavailableReason || '当前预设未配置解释角色')
                : '创建独立解释分支，使用专用诊断角色；可读取、搜索并运行诊断命令，不修改原任务。'"
              placement="top"
              :show-after="180"
            >
              <span class="branch-info" aria-hidden="true">ⓘ</span>
            </ElTooltip>
          </span>
          <span class="branch-action-wrap">
            <button
              type="button"
              class="branch-head-action is-continuation"
              @click="emit('branch', 'continuation', node.sourceFact!.id)"
            ><span aria-hidden="true">⑂</span>从此处继续</button>
            <ElTooltip
              content="从该历史状态创建并列任务分支并继承原角色；节点之后已经发生的工具副作用不会撤销。"
              placement="top"
              :show-after="180"
            >
              <span class="branch-info" aria-hidden="true">ⓘ</span>
            </ElTooltip>
          </span>
        </div>
        <button
          v-if="pinned && !approval && !question"
          type="button"
          class="icon-button close-button"
          aria-label="关闭详情"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div
        v-if="batch && toolBatchUsesTabs(batch.calls)"
        class="tool-tabs"
        role="tablist"
        aria-label="工具类型"
      >
        <button
          v-for="call in batch.calls"
          :key="call.callId"
          type="button"
          role="tab"
          :aria-selected="call.callId === selectedCall?.callId"
          :class="{ active: call.callId === selectedCall?.callId }"
          @click="emit('selectCall', call.callId)"
        >
          <span class="tool-tab-icon" aria-hidden="true">{{ toolGlyph(call.name) }}</span>
          <span class="tool-tab-label">{{ toolLabel(call.name) }}</span>
        </button>
      </div>
    </div>

    <div class="popover-body">
      <div v-if="batch" class="batch-lead">
        <section v-if="nodeThinking" class="thinking-block">
          <button
            type="button"
            class="thinking-toggle"
            :aria-expanded="thinkingOpen"
            @click="thinkingOpen = !thinkingOpen"
          >
            <span class="thinking-glyph" aria-hidden="true">✦</span>
            <span>思考</span>
            <span class="thinking-toggle-hint" aria-hidden="true">
              {{ thinkingOpen ? '−' : '+' }}
            </span>
          </button>
          <div v-if="thinkingOpen" class="thinking-body">
            <div class="markdown-body thinking-copy" v-html="renderMarkdown(nodeThinking)" />
          </div>
        </section>
        <section v-if="nodeDescription" class="actual-description detail-field">
          <small class="detail-label">说明</small>
          <div class="detail-value">
            <div class="markdown-body" v-html="renderMarkdown(nodeDescription)" />
          </div>
        </section>
        <div
          v-if="nodeContent"
          class="markdown-body primary-content batch-lead-content"
          v-html="renderedNodeContent"
        />
      </div>
      <section v-if="approval || question" class="node-action">
        <ApprovalCard v-if="approval && chatId" :approval="approval" :chat-id="chatId" />
        <QuestionCard
          v-else-if="question && chatId"
          :question="question.question"
          :chat-id="chatId"
          :batch-info="batchInfo"
        />
      </section>

      <template v-if="batch && !approval && !question">
        <Transition name="tool-content" mode="out-in">
          <section v-if="selectedCall" :key="selectedCall.callId" class="tool-detail">
            <div class="single-tool-status">
              <span :class="`status-${selectedCall.status}`">{{ selectedStatus }}</span>
            </div>
            <section v-if="actualDescription" class="actual-description detail-field">
              <small class="detail-label">说明</small>
              <div class="detail-value">
                <div class="markdown-body" v-html="renderMarkdown(actualDescription)" />
              </div>
            </section>

            <section v-if="isSpawnTool" class="spawn-detail">
              <div class="spawn-field detail-field">
                <small class="detail-label">派遣角色</small>
                <div class="detail-value is-copyable">
                  <code>{{ spawnRole || '未指定' }}</code>
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'spawn-role' ? '已复制' : '复制派遣角色'"
                    :aria-label="copiedFieldKey === 'spawn-role' ? '已复制' : '复制派遣角色'"
                    @click="copyField('spawn-role', spawnRole)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
              </div>
              <div class="spawn-field detail-field">
                <small class="detail-label">派遣信息</small>
                <div class="detail-value is-copyable">
                  <span>{{ spawnWake }}</span>
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'spawn-wake' ? '已复制' : '复制派遣信息'"
                    :aria-label="copiedFieldKey === 'spawn-wake' ? '已复制' : '复制派遣信息'"
                    @click="copyField('spawn-wake', spawnWake)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
              </div>
              <div class="spawn-field detail-field is-prompt">
                <small class="detail-label">派遣提示词</small>
                <div class="detail-value is-copyable">
                  <div class="markdown-body" v-html="renderMarkdown(spawnPrompt)" />
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'spawn-prompt' ? '已复制' : '复制派遣提示词'"
                    :aria-label="copiedFieldKey === 'spawn-prompt' ? '已复制' : '复制派遣提示词'"
                    @click="copyField('spawn-prompt', spawnPrompt)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
              </div>
            </section>

            <template v-else>
              <section v-if="isReadFileTool" class="file-detail">
                <div class="file-detail-row detail-field">
                  <small class="detail-label">文件路径</small>
                  <div class="detail-value is-copyable file-path-line">
                    <code>{{ readFilePath || '未提供路径' }}</code>
                    <button
                      v-if="readFilePath"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'read-path' ? '已复制' : '复制文件路径'"
                      :aria-label="copiedFieldKey === 'read-path' ? '已复制' : '复制文件路径'"
                      @click="copyField('read-path', readFilePath)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div class="file-detail-row detail-field">
                  <small class="detail-label">读取范围</small>
                  <div class="detail-value">
                    <span>{{ readFileRange }}</span>
                  </div>
                </div>
                <div v-if="readFilePreview" class="file-content-block detail-field">
                  <small class="detail-label">文件内容 · {{ readFileLineCount }} 行</small>
                  <div class="detail-value is-copyable is-multiline">
                    <pre>{{ readFilePreview }}</pre>
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'read-content' ? '已复制' : '复制文件内容'"
                      :aria-label="copiedFieldKey === 'read-content' ? '已复制' : '复制文件内容'"
                      @click="copyField('read-content', readFileContent)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                  <p v-if="resultTruncated" class="truncation-hint">
                    内容较长，当前仅展示前 {{ RESULT_PREVIEW_LIMIT }} 个字符；复制保留完整内容。
                  </p>
                </div>
                <p v-else class="empty-detail">暂无可展示的文件内容。</p>
              </section>

              <section v-else-if="isQuestionTool" class="question-detail">
                <template v-if="questionArgs">
                  <div class="question-heading">
                    <span v-if="questionArgs.header">{{ questionArgs.header }}</span>
                    <small>{{ questionArgs.multiSelect ? '多选' : '单选' }}</small>
                  </div>
                  <p class="question-text">{{ questionArgs.question }}</p>
                  <div
                    class="question-options"
                    role="list"
                    :aria-label="questionArgs.multiSelect ? '多选选项' : '单选选项'"
                  >
                    <div
                      v-for="option in questionArgs.options"
                      :key="option.label"
                      class="question-option"
                      :class="{ selected: isQuestionOptionSelected(option.label) }"
                      role="listitem"
                    >
                      <span
                        class="question-control"
                        :class="{ 'is-multi': questionArgs.multiSelect }"
                        aria-hidden="true"
                      >
                        {{ isQuestionOptionSelected(option.label) ? '✓' : '' }}
                      </span>
                      <span class="question-option-copy">
                        <strong>{{ option.label }}</strong>
                        <small v-if="option.description">{{ option.description }}</small>
                      </span>
                    </div>
                  </div>
                  <div
                    v-if="questionAnswer.kind === 'answered' && questionAnswer.freeText"
                    class="question-other detail-field"
                  >
                    <small class="detail-label">其他补充</small>
                    <div class="detail-value">
                      <p>{{ questionAnswer.freeText }}</p>
                    </div>
                  </div>
                  <p v-else-if="questionAnswer.kind === 'cancelled'" class="question-note">
                    用户已取消该问题。
                  </p>
                  <p v-else-if="questionAnswer.kind === 'running'" class="question-note">
                    等待用户选择…
                  </p>
                </template>
                <pre v-else class="question-fallback">{{ selectedCall.arguments }}</pre>
              </section>

              <section v-else-if="isSearchTool" class="search-detail">
                <div class="search-summary-bar">
                  <span class="search-mode-badge">{{ searchMode }}</span>
                  <span v-if="searchResult.items.length">
                    {{ searchResult.items.length }} 项结果
                  </span>
                </div>
                <div class="detail-field">
                  <small class="detail-label">搜索内容</small>
                  <div class="detail-value is-copyable">
                    <code>{{ searchQuery || '未提供搜索内容' }}</code>
                    <button
                      v-if="searchQuery"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'search-query' ? '已复制' : '复制搜索内容'"
                      :aria-label="copiedFieldKey === 'search-query' ? '已复制' : '复制搜索内容'"
                      @click="copyField('search-query', searchQuery)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div class="detail-field">
                  <small class="detail-label">搜索范围</small>
                  <div class="detail-value is-copyable">
                    <code>{{ searchPath || '未提供搜索范围' }}</code>
                    <button
                      v-if="searchPath"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'search-path' ? '已复制' : '复制搜索范围'"
                      :aria-label="copiedFieldKey === 'search-path' ? '已复制' : '复制搜索范围'"
                      @click="copyField('search-path', searchPath)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div class="detail-field">
                  <small class="detail-label">搜索配置</small>
                  <div class="detail-value search-configuration">
                    <span v-for="item in searchConfiguration" :key="item">{{ item }}</span>
                  </div>
                </div>
                <div v-if="selectedCall.result" class="detail-field search-results-field">
                  <small class="detail-label">搜索结果</small>
                  <div class="detail-value is-copyable is-multiline search-results">
                    <p v-if="searchResult.summary" class="search-result-summary">
                      {{ searchResult.summary }}
                    </p>
                    <div v-if="searchResult.items.length" class="search-result-list">
                      <div
                        v-for="(result, index) in searchResult.items"
                        :key="`${result.filePath}:${result.line ?? index}`"
                        class="search-result-item"
                      >
                        <div class="search-result-location">
                          <code>{{ result.filePath }}</code>
                          <span v-if="result.line">第 {{ result.line }} 行</span>
                          <span v-if="result.gitStatus">{{ result.gitStatus }}</span>
                        </div>
                        <pre v-if="result.content">{{ result.content }}</pre>
                      </div>
                    </div>
                    <pre v-else-if="!searchResult.summary" class="search-result-raw">{{
                      selectedCall.result
                    }}</pre>
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'search-result' ? '已复制' : '复制搜索结果'"
                      :aria-label="copiedFieldKey === 'search-result' ? '已复制' : '复制搜索结果'"
                      @click="copyField('search-result', selectedCall.result)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <p v-else class="empty-detail">等待搜索结果…</p>
              </section>

              <section v-else-if="isSkillTool" class="skill-detail">
                <div class="detail-field">
                  <small class="detail-label">技能名称</small>
                  <div class="detail-value is-copyable skill-name-value">
                    <span class="skill-glyph" aria-hidden="true">⚡</span>
                    <strong>{{ skillResult.name || '未提供技能名称' }}</strong>
                    <button
                      v-if="skillResult.name"
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'skill-name' ? '已复制' : '复制技能名称'"
                      :aria-label="copiedFieldKey === 'skill-name' ? '已复制' : '复制技能名称'"
                      @click="copyField('skill-name', skillResult.name)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <div v-if="skillResult.content && !skillResult.error" class="detail-field">
                  <small class="detail-label">技能指令 · {{ skillResult.lineCount }} 行</small>
                  <div class="detail-value is-copyable is-multiline skill-instructions">
                    <div class="markdown-body" v-html="renderMarkdown(skillResult.content)" />
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="copiedFieldKey === 'skill-content' ? '已复制' : '复制技能指令'"
                      :aria-label="copiedFieldKey === 'skill-content' ? '已复制' : '复制技能指令'"
                      @click="copyField('skill-content', skillResult.content)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </div>
                <p v-else-if="skillResult.error" class="tool-error-note">{{ skillResult.error }}</p>
                <p v-else class="empty-detail">等待加载技能指令…</p>
              </section>

              <template v-else>
                <section
                  v-if="primaryInstruction"
                  class="primary-instruction detail-field"
                  :class="`is-${primaryInstruction.kind}`"
                >
                  <small class="detail-label">{{ primaryInstruction.label }}</small>
                  <div class="detail-value is-copyable">
                    <div v-if="primaryInstruction.kind === 'command'" class="command-line">
                      <span aria-hidden="true">$</span>
                      <code>{{ primaryInstruction.value }}</code>
                    </div>
                    <div
                      v-else
                      class="markdown-body instruction-copy"
                      v-html="renderMarkdown(primaryInstruction.value)"
                    />
                    <button
                      type="button"
                      class="field-copy-button"
                      :title="
                        copiedFieldKey === 'primary' ? '已复制' : `复制${primaryInstruction.label}`
                      "
                      :aria-label="
                        copiedFieldKey === 'primary' ? '已复制' : `复制${primaryInstruction.label}`
                      "
                      @click="copyField('primary', primaryInstruction.value)"
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                </section>

                <dl v-if="secondaryFields.length" class="field-list">
                  <div
                    v-for="field in secondaryFields"
                    :key="field.key"
                    class="field-row"
                    :class="`is-${field.kind}`"
                  >
                    <dt class="detail-label">{{ field.label }}</dt>
                    <dd class="detail-value" :class="{ 'is-copyable': isCopyableField(field) }">
                      <code
                        v-if="
                          field.kind === 'path' || field.kind === 'url' || field.kind === 'scalar'
                        "
                      >
                        {{ field.value }}
                      </code>
                      <pre v-else-if="field.kind === 'structured' || field.kind === 'multiline'">{{
                        field.value
                      }}</pre>
                      <div v-else class="markdown-body" v-html="renderMarkdown(field.value)" />
                      <button
                        v-if="isCopyableField(field)"
                        type="button"
                        class="field-copy-button"
                        :title="copiedFieldKey === field.key ? '已复制' : `复制${field.label}`"
                        :aria-label="copiedFieldKey === field.key ? '已复制' : `复制${field.label}`"
                        @click="copyField(field.key, field.value)"
                      >
                        <span aria-hidden="true">⧉</span>
                      </button>
                    </dd>
                  </div>
                </dl>
              </template>

              <section
                v-if="
                  selectedCall.result &&
                  !isReadFileTool &&
                  !isQuestionTool &&
                  !isSearchTool &&
                  !isSkillTool
                "
                class="result-block detail-field"
              >
                <small class="detail-label">执行结果</small>
                <div class="detail-value is-copyable is-multiline">
                  <div class="markdown-body result-copy" v-html="renderedResult" />
                  <button
                    type="button"
                    class="field-copy-button"
                    :title="copiedFieldKey === 'result' ? '已复制' : '复制执行结果'"
                    :aria-label="copiedFieldKey === 'result' ? '已复制' : '复制执行结果'"
                    @click="copyField('result', selectedCall.result)"
                  >
                    <span aria-hidden="true">⧉</span>
                  </button>
                </div>
                <p v-if="resultTruncated" class="truncation-hint">
                  完整结果已保留，可通过复制获取。
                </p>
              </section>
              <p
                v-else-if="
                  !isReadFileTool &&
                  !isQuestionTool &&
                  !isSearchTool &&
                  !isSkillTool &&
                  (selectedCall.status === 'pending' || selectedCall.status === 'accepted')
                "
                class="empty-detail"
              >
                等待执行结果…
              </p>
            </template>
          </section>
          <p v-else key="empty" class="empty-detail">暂无可展示内容。</p>
        </Transition>

        <ul v-if="batch.terminations.length" class="termination-list" aria-label="执行终止提示">
          <li
            v-for="termination in batch.terminations"
            :key="`${termination.batchId}:${termination.code}`"
          >
            {{ terminationDisplay({ actor: 'system', code: termination.code, at: 0 }).label }}
          </li>
        </ul>
      </template>

      <section v-else-if="!batch" class="node-content">
        <section v-if="nodeThinking" class="thinking-block">
          <button
            type="button"
            class="thinking-toggle"
            :aria-expanded="thinkingOpen"
            @click="thinkingOpen = !thinkingOpen"
          >
            <span class="thinking-glyph" aria-hidden="true">✦</span>
            <span>思考</span>
            <span class="thinking-toggle-hint" aria-hidden="true">{{ thinkingOpen ? '−' : '+' }}</span>
          </button>
          <div v-if="thinkingOpen" class="thinking-body">
            <div class="markdown-body thinking-copy" v-html="renderMarkdown(nodeThinking)" />
          </div>
        </section>
        <section v-if="nodeDescription" class="actual-description detail-field">
          <small class="detail-label">说明</small>
          <div class="detail-value">
            <div class="markdown-body" v-html="renderMarkdown(nodeDescription)" />
          </div>
        </section>
        <template v-if="nodeContent">
          <div v-if="isUserNode" class="primary-content user-node-content">
            <template
              v-for="(segment, index) in nodeContentSegments"
              :key="`${segment.type}-${index}`"
            >
              <span
                v-if="segment.type === 'command'"
                class="node-command-token"
                :aria-label="`指令 ${segment.value}`"
              >
                <span class="node-command-token-kind" aria-hidden="true">指令</span>
                <span class="node-command-token-value">{{ segment.value }}</span>
              </span>
              <template v-else>
                {{ segment.type === 'role' ? `[[role:${segment.value}]]` : segment.value }}
              </template>
            </template>
          </div>
          <div v-else class="markdown-body primary-content" v-html="renderedNodeContent" />
        </template>
        <p v-else-if="!nodeDescription && !nodeThinking" class="empty-detail">暂无正文。</p>
        <p v-if="nodeTermination" class="termination-note" :class="`tone-${nodeTermination.tone}`">
          {{ nodeTermination.label }}
        </p>
      </section>
    </div>
  </aside>
</template>

<style scoped lang="less">
.branch-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.branch-action-wrap {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.branch-head-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  border: none;
  border-radius: 4px;
  padding: 0 6px;
  font: 600 10px/1 system-ui, sans-serif;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, opacity 0.15s ease;
}
.branch-head-action:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.branch-head-action.is-detail { color: var(--nx-cyan); }
.branch-head-action.is-continuation { color: var(--nx-yellow); }
.branch-head-action:disabled { cursor: not-allowed; opacity: 0.38; }
.branch-info { color: var(--nx-text-dim); font-size: 11px; line-height: 1; }
@import '@/styles/markdown.less';

// 节点 hover 悬浮窗：随深浅主题翻转（引用全局 --nx-* CRT token）。
@bg: var(--nx-bg);
@surface: var(--nx-code-bg);
@ink: var(--nx-text);
@muted: var(--nx-text-dim);
@accent: var(--nx-cyan);
@line: var(--nx-border-soft);
@ease-out: cubic-bezier(0.23, 1, 0.32, 1);

.node-popover {
  width: min(480px, calc(100vw - 24px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: @ink;
  border: 1px solid var(--nx-border);
  border-radius: 4px;
  background: @bg;
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.42),
    inset 0 1px color-mix(in srgb, var(--nx-text) 6%, transparent);
  transform-origin: var(--popover-origin, left center);
  transition:
    opacity 170ms @ease-out,
    transform 170ms @ease-out;
  user-select: text;
  -webkit-user-select: text;
  cursor: auto;
  @starting-style {
    opacity: 0;
    transform: translateY(3px) scale(0.97);
  }
}
.node-popover.is-pinned,
.node-popover.is-actionable {
  border-color: color-mix(in srgb, var(--nx-cyan) 68%, transparent);
}
.popover-chrome {
  flex: 0 0 auto;
  box-shadow: 0 1px color-mix(in srgb, var(--nx-text) 5%, transparent);
}
.popover-head {
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid @line;
}
.title-icon {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: @accent;
  font-size: 13px;
}
.popover-head strong {
  min-width: 0;
  overflow: hidden;
    color: var(--nx-text);
      font:
    650 12px/1.2 system-ui,
    sans-serif;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.node-time {
  flex: 0 0 auto;
  color: var(--nx-text-dim);
  font:
    9.5px/1.2 system-ui,
    sans-serif;
}
.branch-head-actions + .close-button { margin-left: 0; }
.status-pill {
  flex: 0 0 auto;
  padding: 2px 5px;
  color: @muted;
  border: 1px solid @line;
  border-radius: 3px;
  font:
    9px/1.2 system-ui,
    sans-serif;
}
.status-error,
.status-rejected {
  color: var(--nx-red);
}
.status-active,
.status-accepted,
.status-pending {
  color: var(--nx-yellow);
}
.icon-button,
.copy-button {
  border: 1px solid transparent;
  border-radius: 3px;
  color: @muted;
  background: transparent;
  cursor: pointer;
  transition:
    transform 120ms @ease-out,
    color 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease;
}
.icon-button:active,
.copy-button:active,
.tool-tabs button:active {
  transform: scale(0.97);
}
.close-button {
  width: 24px;
  height: 24px;
  margin-left: auto;
  font-size: 16px;
}
.batch-lead {
  display: grid;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid @line;
}
.batch-lead .actual-description {
  margin-bottom: 0;
}
.batch-lead .thinking-block {
  margin-bottom: 0;
}
.batch-lead-content {
  color: var(--nx-text-dim);
  font:
    10.5px/1.55 system-ui,
    sans-serif;
}
.tool-tabs {
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.tool-tabs::-webkit-scrollbar {
  display: none;
}
.tool-tabs button {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 32px;
  max-width: 160px;
  padding: 0 9px;
  border: 0;
  color: @muted;
  background: transparent;
  cursor: pointer;
  transition:
    transform 120ms @ease-out,
    color 120ms ease,
    background-color 120ms ease;
}
.tool-tab-icon {
  flex: 0 0 16px;
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  overflow: hidden;
  font-size: 11px;
  line-height: 1;
}
.tool-tabs button::after {
  content: '';
  position: absolute;
  right: 8px;
  bottom: 0;
  left: 8px;
  height: 2px;
  background: @accent;
  opacity: 0;
  transform: scaleX(0.6);
  transition:
    opacity 140ms ease,
    transform 140ms @ease-out;
}
.tool-tab-label {
  min-width: 0;
  overflow: hidden;
  font:
    10px/1.2 system-ui,
    sans-serif;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-tabs button.active {
  color: var(--nx-text);
}
.tool-tabs button.active::after {
  opacity: 1;
  transform: scaleX(1);
}
.popover-body {
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-color: color-mix(in srgb, var(--nx-border) 60%, transparent) transparent;
  scrollbar-width: thin;
}
.popover-body::-webkit-scrollbar {
  width: 6px;
}
.popover-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--nx-border) 60%, transparent);
}
.node-action {
  padding: 8px;
  border-bottom: 1px solid @line;
  // 待处理交互卡片（审批/提问）是独立组件，自身用全局主题 token（--ink/--surface-hover 等）。
  // popover 随主题翻转，此处把 token 覆写为当月 --nx-* 调色，使卡片正文/内表面与 popover 一致。
  --ink: @ink;
  --surface: @surface;
  --surface-hover: color-mix(in srgb, var(--nx-text) 8%, var(--nx-bg));
  --surface-soft: color-mix(in srgb, var(--nx-bg) 90%, transparent);
  --border: @line;
  color: @ink;
}
.node-action :deep(.approval-card),
.node-action :deep(.question-card) {
  width: auto;
  max-width: none;
}
.tool-detail,
.node-content {
  padding: 10px 12px 12px;
}
.single-tool-status {
  display: flex;
  justify-content: flex-end;
  margin: -2px 0 6px;
  font:
    9px/1.2 system-ui,
    sans-serif;
}
.single-tool-status .status-completed {
  color: var(--nx-green);
}
.single-tool-status .status-error,
.single-tool-status .status-rejected {
  color: var(--nx-red);
}
.single-tool-status .status-accepted,
.single-tool-status .status-pending {
  color: var(--nx-yellow);
}
.actual-description {
  margin-bottom: 10px;
  border-left: 2px solid @accent;
  padding-left: 6px;
}
.thinking-block {
  margin-bottom: 10px;
}
.thinking-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--nx-purple) 32%, transparent);
  border-radius: 3px;
  color: var(--nx-purple);
  background: color-mix(in srgb, var(--nx-purple) 6%, transparent);
  cursor: pointer;
  font:
    650 10px/1.2 system-ui,
    sans-serif;
  letter-spacing: 0.03em;
  text-align: left;
}
.thinking-glyph {
  flex: 0 0 auto;
  font-size: 11px;
}
.thinking-toggle-hint {
  flex: 0 0 auto;
  margin-left: auto;
  color: color-mix(in srgb, var(--nx-purple) 72%, transparent);
  font-weight: 800;
}
.thinking-toggle:hover,
.thinking-toggle:focus-visible {
  background: color-mix(in srgb, var(--nx-purple) 10%, transparent);
}
.thinking-body {
  margin-top: 6px;
  padding: 7px 9px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--nx-purple) 5%, transparent);
}
.thinking-copy {
  color: var(--nx-text-dim);
}
.field-copy-button {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  color: @muted;
  background: transparent;
  cursor: pointer;
  font:
    13px/1 ui-monospace,
    monospace;
  opacity: 0.3;
  transition:
    color 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease,
    opacity 140ms ease;
}
.field-copy-button:hover,
.field-copy-button:focus-visible {
  color: var(--nx-text);
  background: color-mix(in srgb, var(--nx-cyan) 8%, transparent);
  opacity: 1;
}
.detail-field {
  min-width: 0;
}
.detail-label {
  display: block;
  margin: 0 0 4px;
  color: @accent;
  font:
    650 9px/1.2 system-ui,
    sans-serif;
  letter-spacing: 0.05em;
}
.detail-value {
  position: relative;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid @line;
  border-left-color: var(--detail-accent, @line);
  border-radius: 3px;
  color: var(--nx-text-dim);
  font-size: 10.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.detail-value.is-copyable {
  padding-right: 34px;
}
.detail-value.is-multiline {
}
.detail-value > :first-child {
  margin-top: 0;
}
.detail-value > :last-child:not(.field-copy-button) {
  margin-bottom: 0;
}
.spawn-detail {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
}
.spawn-field {
  min-width: 0;
  color: var(--nx-text-dim);
}
.spawn-field code {
    color: var(--nx-purple);
      font:
    10.5px/1.5 ui-monospace,
    'JetBrains Mono',
    monospace;
}
.spawn-field.is-prompt {
  --detail-accent: color-mix(in srgb, var(--nx-purple) 62%, transparent);
}
.primary-instruction {
  margin-bottom: 10px;
}
.instruction-copy {
  color: var(--nx-text);
}
.command-line {
  display: flex;
  align-items: flex-start;
  gap: 7px;
    color: var(--nx-text);
      font:
    11px/1.55 ui-monospace,
    'JetBrains Mono',
    monospace;
}
.command-line > span {
  flex: 0 0 auto;
  color: var(--nx-green);
}
.command-line code {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.user-node-content {
  color: var(--nx-text-dim);
  font: 10.5px/1.65 system-ui, sans-serif;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.node-command-token {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  margin: 1px 4px 1px 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--nx-yellow) 58%, transparent);
  border-radius: 3px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--nx-yellow) 26%, transparent), color-mix(in srgb, var(--nx-yellow) 12%, transparent));
  box-shadow:
    inset 0 1px color-mix(in srgb, var(--nx-yellow) 14%, transparent),
    0 0 10px color-mix(in srgb, var(--nx-yellow) 8%, transparent);
    color: var(--nx-yellow);
      font:
    650 10.5px/1.55 ui-monospace,
    'JetBrains Mono',
    monospace;
  letter-spacing: 0.015em;
  vertical-align: middle;
  white-space: nowrap;
}
.node-command-token-kind {
  flex: 0 0 auto;
  align-self: stretch;
  display: inline-grid;
  place-items: center;
  padding: 1px 5px;
  border-right: 1px solid color-mix(in srgb, var(--nx-yellow) 34%, transparent);
  background: color-mix(in srgb, var(--nx-yellow) 13%, transparent);
  color: color-mix(in srgb, var(--nx-yellow) 78%, transparent);
  font-size: 8px;
  line-height: 1;
  letter-spacing: 0.09em;
}
.node-command-token-value {
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  padding: 1px 6px;
  text-overflow: ellipsis;
}
.field-list {
  margin: 0 0 10px;
  border-top: 1px solid @line;
}
.field-row {
  display: block;
  padding: 7px 2px 8px;
  border-bottom: 1px solid @line;
}
.field-row dt {
  margin: 0 0 4px;
  color: @muted;
  font:
    9px/1.45 system-ui,
    sans-serif;
}
.field-row dd {
  margin: 0;
}
.field-row code,
.field-row pre {
  margin: 0;
    color: var(--nx-text-dim);
      font:
    10px/1.5 ui-monospace,
    'JetBrains Mono',
    monospace;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.file-detail,
.question-detail,
.search-detail,
.skill-detail {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
}
.file-detail-row {
  min-width: 0;
}
.file-path-line {
  display: block;
}
.file-path-line code {
  display: block;
  min-width: 0;
    color: var(--nx-text-dim);
      font:
    10.5px/1.5 ui-monospace,
    'JetBrains Mono',
    monospace;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.file-content-block {
  padding-top: 1px;
}
.file-content-block pre,
.question-fallback {
  max-width: 100%;
  max-height: 360px;
  margin: 0;
  overflow: auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: var(--nx-text-dim);
  font:
    10px/1.55 ui-monospace,
    'JetBrains Mono',
    monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
.question-heading {
  display: flex;
  align-items: center;
  gap: 7px;
}
.question-heading > span {
  min-width: 0;
  flex: 1;
  color: var(--nx-text);
  font-weight: 650;
  overflow-wrap: anywhere;
  font-size: 14px;
}
.question-heading > small {
  flex: 0 0 auto;
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--nx-purple) 36%, transparent);
  border-radius: 3px;
  color: var(--nx-purple);
  font-size: 9px;
}
.question-text {
  margin: 0;
  color: var(--nx-text);
  font-weight: 600;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.question-options {
  display: grid;
  gap: 5px;
}
.question-option {
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr);
  align-items: start;
  gap: 7px;
  padding: 7px 8px;
  border: 1px solid @line;
  border-radius: 3px;
  color: var(--nx-text-dim);
}
.question-option.selected {
  border-color: color-mix(in srgb, var(--nx-purple) 58%, transparent);
  color: var(--nx-purple);
}
.question-control {
  display: grid;
  place-items: center;
  width: 13px;
  height: 13px;
  margin-top: 1px;
  line-height: 0;
  border: 1px solid color-mix(in srgb, var(--nx-purple) 54%, transparent);
  border-radius: 50%;
  color: var(--nx-purple);
  font-weight: 800;
}
.question-control.is-multi {
  border-radius: 2px;
}
.question-option-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.question-option-copy strong {
  font-size: 10.5px;
  overflow-wrap: anywhere;
}
.question-option-copy small {
  color: @muted;
  font-size: 9.5px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.question-other {
  --detail-accent: color-mix(in srgb, var(--nx-purple) 62%, transparent);
}
.question-other p,
.question-note {
  margin: 0;
  color: var(--nx-text-dim);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.question-note {
  color: @muted;
}
.search-summary-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 22px;
  color: @muted;
  font-size: 9.5px;
}
.search-mode-badge {
  padding: 2px 6px;
  border: 1px solid color-mix(in srgb, var(--nx-cyan) 36%, transparent);
  border-radius: 3px;
  color: var(--nx-cyan);
  font-weight: 650;
}
.search-configuration {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  white-space: normal;
}
.search-configuration span {
  padding: 2px 5px;
  border: 1px solid var(--nx-border-soft);
  border-radius: 3px;
  color: var(--nx-text-dim);
  font-size: 9.5px;
}
.search-results-field {
  min-width: 0;
}
.search-results {
  padding-top: 0;
  padding-bottom: 0;
}
.search-result-summary {
  margin: 0;
  padding: 8px 25px 8px 0;
  color: var(--nx-text-dim);
  line-height: 1.45;
}
.search-result-list {
  display: grid;
}
.search-result-item {
  min-width: 0;
  padding: 7px 0;
  border-top: 1px solid @line;
}
.search-result-location {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.search-result-location code {
  min-width: 0;
  flex: 1;
    color: var(--nx-cyan);
      font:
    650 10px/1.45 ui-monospace,
    'JetBrains Mono',
    monospace;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.search-result-location span {
  flex: 0 0 auto;
  color: @muted;
  font-size: 9px;
}
.search-result-item pre,
.search-result-raw {
  margin: 4px 0 0;
  padding: 5px 7px;
  color: var(--nx-text-dim);
  background: color-mix(in srgb, var(--nx-cyan) 4%, transparent);
  font:
    10px/1.5 ui-monospace,
    'JetBrains Mono',
    monospace;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.skill-name-value {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--nx-yellow);
  background: color-mix(in srgb, var(--nx-yellow) 5.5%, transparent);
}
.skill-glyph {
  flex: 0 0 auto;
  color: var(--nx-yellow);
}
.skill-name-value strong {
  min-width: 0;
  overflow-wrap: anywhere;
}
.skill-instructions {
  --detail-accent: color-mix(in srgb, var(--nx-yellow) 58%, transparent);
}
.tool-error-note {
  margin: 0;
  padding: 7px 8px;
  border-left: 2px solid var(--nx-red);
  color: var(--nx-red);
  font-size: 10px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.result-block {
  border-top: 1px solid @line;
}
.section-heading {
  height: 31px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-heading strong {
    color: var(--nx-text-dim);
      font:
    650 10px/1.2 system-ui,
    sans-serif;
}
.copy-button {
  padding: 3px 6px;
  font:
    9px/1.2 system-ui,
    sans-serif;
}
.primary-content,
.result-copy {
  color: var(--nx-text-dim);
}
.markdown-body {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--nx-text-dim);
  font:
    10.5px/1.55 system-ui,
    sans-serif;
  .md-content();
}
.markdown-body :deep(p) {
  white-space: pre-wrap;
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  color: var(--nx-text);
}
.markdown-body :deep(pre) {
  max-width: 100%;
  overflow: visible;
  padding: 7px 8px;
  color: var(--nx-text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.markdown-body :deep(code) {
  color: var(--nx-text-dim);
}
.markdown-body :deep(blockquote) {
  color: @muted;
  border-color: color-mix(in srgb, var(--nx-cyan) 45%, transparent);
}
.markdown-body :deep(a) {
  color: var(--nx-cyan);
}
.empty-detail,
.truncation-hint {
  margin: 0;
  padding: 8px 0;
  color: @muted;
  font:
    10px/1.45 system-ui,
    sans-serif;
}
.truncation-hint {
  color: var(--nx-yellow);
}
.termination-list,
.termination-note {
  margin: 0 12px 10px;
  padding: 6px 8px;
  border-left: 2px solid var(--nx-yellow);
  color: var(--nx-yellow);
  font:
    10px/1.4 system-ui,
    sans-serif;
}
.termination-list {
  list-style: none;
}
.termination-note {
  margin: 10px 0 0;
}
.tool-content-enter-active,
.tool-content-leave-active {
  transition: opacity 130ms @ease-out;
}
.tool-content-enter-from,
.tool-content-leave-to {
  opacity: 0;
}
@media (hover: hover) and (pointer: fine) {
  .icon-button:hover,
  .copy-button:hover {
    color: var(--nx-text);
    background: color-mix(in srgb, var(--nx-cyan) 7%, transparent);
  }
  .tool-tabs button:hover {
    color: var(--nx-text);
  }
}
@media (prefers-reduced-motion: reduce) {
  .node-popover {
    transform: none;
    transition: opacity 150ms ease;
    @starting-style {
      opacity: 0;
      transform: none;
    }
  }
  .icon-button,
  .copy-button,
  .tool-tabs button,
  .tool-tabs button::after {
    transition:
      color 120ms ease,
      border-color 120ms ease,
      background-color 120ms ease,
      opacity 120ms ease;
  }
}
</style>
