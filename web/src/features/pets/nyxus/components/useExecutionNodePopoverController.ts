import { computed, ref, watch } from 'vue'
import { ElTooltip } from 'element-plus'
import { splitCommandPrompt } from '@/features/agent/composables/commands'
import {
  parseQuestionAnswer,
  parseQuestionArgs,
} from '@/features/agent/renderers/core/questionDisplay'
import { useNyxusHost } from '../application/host'
import type { ApprovalState } from '@/domain/chat/projectionTypes'
import { renderMarkdown } from '@/utils/markdown'
import { formatTime } from '@/utils/formatTime'
import { createToolRunPresentation } from '@/utils/approvalPresentation'
import { toSenseNameZh } from '@/utils/senseName'
import type { ExecutionEdge, ExecutionNode } from '../graph/executionGraph'
import { skinForNode } from '../graph/nodeSkins'
import type { NodePopoverQuestion } from '../graph/nodePopoverModel'
import ToolFieldTree from './ToolFieldTree.vue'
import { selectedToolCall, toolBatchDetail, toolBatchUsesTabs } from '../graph/toolBatchDetails'
import { terminationDisplay } from '../graph/termination'
import {
  displayValue,
  fieldView,
  parseFieldViews,
  parseRecord,
  type FieldView,
} from '../graph/toolArgumentFields'

export type ExecutionNodePopoverControllerProps = {
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
  variant?: 'popover' | 'paper'
  /** 标题栏可拖动（常驻弹窗）。拖动通过 drag emit 上报增量位移。 */
  draggable?: boolean
}
export type ExecutionNodePopoverControllerEmits = {
  close: []
  selectCall: [callId: string]
  branch: [type: 'detail' | 'continuation', nodeId: string]
  drag: [delta: { x: number; y: number }]
}
type ControllerEmit<T> = <K extends keyof T>(event: K, ...args: T[K] extends unknown[] ? T[K] : never) => void

export function useExecutionNodePopoverController(props: ExecutionNodePopoverControllerProps, emit: ControllerEmit<ExecutionNodePopoverControllerEmits>) {
  const RESULT_PREVIEW_LIMIT = 20_000
  
  const DESCRIPTION_KEYS = ['description', 'explanation'] as const
  
  const INSTRUCTION_KEYS = ['task', 'prompt', 'query', 'instruction', 'command'] as const
  
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
  
  const { agents } = useNyxusHost()
  
  const batch = computed(() => toolBatchDetail(props.node))
  
  const copiedFieldKey = ref('')
  
  // ── 标题栏拖拽（常驻弹窗）：pointer-capture 模式，drag emit 上报增量位移 ──
  
  let dragPointerId = -1
  
  let dragX = 0
  
  let dragY = 0
  
  function onHeaderPointerDown(event: PointerEvent): void {
  
    if (!props.draggable) return
  
    dragPointerId = event.pointerId
  
    dragX = event.clientX
  
    dragY = event.clientY
  
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  
  }
  
  function onHeaderPointerMove(event: PointerEvent): void {
  
    if (event.pointerId !== dragPointerId) return
  
    emit('drag', { x: event.clientX - dragX, y: event.clientY - dragY })
  
    dragX = event.clientX
  
    dragY = event.clientY
  
  }
  
  function onHeaderPointerUp(event: PointerEvent): void {
  
    if (event.pointerId !== dragPointerId) return
  
    const target = event.currentTarget as HTMLElement
  
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
  
    dragPointerId = -1
  
  }
  
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
  
  /** 询问场景当前活动问题对应的调用（calls 与 questions 按序一一对应）。驱动 tab 高亮联动。 */
  
  const activeQuestionCall = computed(() =>
  
    props.question ? batch.value?.calls[props.question.currentIndex] : undefined,
  
  )
  
  const toolMeta = computed(() => {
  
    const name = selectedCall.value?.name
  
    return name ? agents.senseTools.find((tool) => tool.name === name) : undefined
  
  })
  
  const toolIcon = computed(() => toolMeta.value?.icon || '⚙')
  
  const toolName = computed(() =>
    toolMeta.value?.label?.trim() || toSenseNameZh(selectedCall.value?.name),
  )
  
  const selectedStatus = computed(() =>
  
    selectedCall.value ? statusLabel(selectedCall.value.status) : statusLabel(batch.value?.status),
  
  )
  
  const parsedArguments = computed(() => parseRecord(selectedCall.value?.arguments))
  const toolPresentation = computed(() =>
    selectedCall.value
      ? createToolRunPresentation(selectedCall.value.name, selectedCall.value.arguments)
      : undefined,
  )
  
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
  
  const resultFields = computed(() => parseFieldViews(selectedCall.value?.result))
  
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
  
  function statusLabel(status?: string): string {
  
    return status ? STATUS_LABELS[status] || '状态已更新' : '状态未知'
  
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
  
  function isCopyableField(field: FieldView): boolean {
  
    return (
  
      field.kind === 'command' ||
  
      field.kind === 'path' ||
  
      field.kind === 'url' ||
  
      field.kind === 'multiline' ||
  
      ['task', 'prompt', 'query', 'instruction'].includes(field.key)
  
    )
  
  }
  
  function toolLabel(name: string): string {
  
    return agents.senseTools.find((tool) => tool.name === name)?.label?.trim() || toSenseNameZh(name)
  
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

  return {
    ElTooltip, RESULT_PREVIEW_LIMIT, ToolFieldTree, activeQuestionCall, actualDescription, batch,
    batchInfo, canBranch, copiedFieldKey, copyField, isQuestionOptionSelected, isQuestionTool,
    isReadFileTool, isSearchTool, isSkillTool, isSpawnTool, isUserNode, nodeContent,
    nodeContentSegments, nodeDescription, nodeStatus, nodeTermination, nodeThinking, nodeTime,
    nodeTitle, onHeaderPointerDown, onHeaderPointerMove, onHeaderPointerUp, primaryInstruction,
    questionAnswer, questionArgs, readFileContent, readFileLineCount, readFilePath, readFilePreview,
    readFileRange, renderMarkdown, renderedNodeContent, renderedResult, resultFields,
    resultTruncated, searchConfiguration, searchMode, searchPath, searchQuery, searchResult,
    secondaryFields, selectedCall, selectedStatus, skillResult, skinForNode, spawnPrompt, spawnRole,
    spawnWake, terminationDisplay, thinkingOpen, toolBatchUsesTabs, toolGlyph, toolIcon, toolLabel,
    toolPresentation,
  }
}
