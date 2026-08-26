import type { GraphToolCall, SenseToolInfo } from '@/application/backend/public'
import { formatTime } from '@/utils/formatTime'
import type { ExecutionEdge, ExecutionNode, ExecutionFoldMember } from '../graph/executionGraph'
import { skinForNode } from '../graph/nodeSkins'
import { terminationDisplay } from '../graph/termination'
import { selectedToolCall, toolBatchDetail } from '../graph/toolBatchDetails'
import {
  displayValue,
  parseFieldViews,
  parseRecord,
  type FieldView,
} from '../graph/toolArgumentFields'

export type PaperPixelIconName =
  | 'adventurer'
  | 'book'
  | 'chest'
  | 'clock'
  | 'companion'
  | 'gear'
  | 'ink'
  | 'magic'
  | 'map'
  | 'quill'
  | 'scroll'
  | 'seal'
  | 'shield'
  | 'spark'
  | 'warning'

export type PaperCardKind =
  | 'adventurer'
  | 'arcanist'
  | 'companion'
  | 'skill'
  | 'treasure'
  | 'quest'
  | 'notice'
  | 'journal'
  | 'anomaly'

export type PaperDetailKind = 'content' | 'thinking' | 'arguments' | 'result' | 'process'

export interface PaperCardStat {
  id: string
  icon: PaperPixelIconName
  label: string
  value: string
}

export interface PaperDetailBlock {
  id: string
  kind: PaperDetailKind
  icon: PaperPixelIconName
  title: string
  hint: string
  content: string
  format: 'markdown' | 'code' | 'plain'
  tone?: 'default' | 'magic' | 'success' | 'warning'
  /** 工具参数解析后的字段列表；存在时优先以字段形式渲染。 */
  fields?: FieldView[]
}

export interface PaperProcessCall {
  id: string
  call: GraphToolCall
  label: string
  icon: PaperPixelIconName
  status: GraphToolCall['status']
}

export interface PaperProcessStage {
  id: string
  index: number
  node: ExecutionNode
  icon: PaperPixelIconName
  label: string
  status: string
  tone: PaperGameCardModel['statusTone']
  summary: string
  /** A multi-call batch remains one ordered process stage. */
  calls: PaperProcessCall[]
  /** Inactive stages keep only cheap inputs; the nested card is built on demand. */
  cardOptions: FoldMemberCardOptions
}

export interface PaperSkillSlot {
  id: string
  icon: PaperPixelIconName
  label: string
  status: GraphToolCall['status']
}

export interface PaperGameCardModel {
  id: string
  kind: PaperCardKind
  icon: PaperPixelIconName
  kicker: string
  title: string
  status: string
  statusTone: 'neutral' | 'active' | 'success' | 'danger'
  time: string
  summary: string
  sequence: string
  stats: PaperCardStat[]
  details: PaperDetailBlock[]
  /** 过程组按执行顺序展示；每个工具批次只占一个阶段。 */
  processStages?: PaperProcessStage[]
  skills: PaperSkillSlot[]
  selectedSkillId?: string
  termination?: { label: string; tone: string }
  canBranch: boolean
}

const STATUS_LABELS: Record<string, string> = {
  active: '施法中',
  accepted: '执行中',
  pending: '等待中',
  completed: '已完成',
  committed: '已记录',
  error: '执行失败',
  rejected: '已拒绝',
  revoked: '已撤回',
  transient: '准备中',
  editing: '书写中',
  consuming: '处理中',
}

function statusLabel(status?: string): string {
  return status ? STATUS_LABELS[status] || '状态更新' : '状态未知'
}

function statusTone(status?: string): PaperGameCardModel['statusTone'] {
  if (status === 'error' || status === 'rejected' || status === 'revoked') return 'danger'
  if (status === 'active' || status === 'accepted' || status === 'pending') return 'active'
  if (status === 'completed' || status === 'committed') return 'success'
  return 'neutral'
}

function cardIdentity(node: ExecutionNode): Pick<PaperGameCardModel, 'kind' | 'icon' | 'kicker'> {
  if (node.kind === 'fold') return { kind: 'journal', icon: 'book', kicker: '任务日志' }
  if (node.kind === 'tool-batch') return { kind: 'skill', icon: 'gear', kicker: '技能卡' }
  if (node.kind === 'return') return { kind: 'treasure', icon: 'chest', kicker: '战利品' }
  if (node.kind === 'dispatch' || node.kind === 'spawn') {
    return { kind: 'quest', icon: 'seal', kicker: '公会委托' }
  }
  if (node.kind === 'system') return { kind: 'notice', icon: 'scroll', kicker: '王国告示' }
  if (node.kind === 'unknown') return { kind: 'anomaly', icon: 'warning', kicker: '未知事件' }
  if (node.actor.kind === 'user' || node.kind === 'input') {
    return { kind: 'adventurer', icon: 'adventurer', kicker: '冒险者记录' }
  }
  if (node.actor.kind === 'agent' && node.sourceChatId !== node.rootChatId) {
    return { kind: 'companion', icon: 'companion', kicker: '伙伴角色卡' }
  }
  return { kind: 'arcanist', icon: 'magic', kicker: '秘法学者' }
}

function contentParts(source: string): { description: string; content: string } {
  const parsed = parseRecord(source)
  if (!Object.keys(parsed).length) return { description: '', content: source.trim() }
  const description = displayValue(parsed.description ?? parsed.explanation).trim()
  const rest = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== 'description' && key !== 'explanation'),
  )
  return {
    description,
    content: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '',
  }
}

function plainSummary(source: string, fallback: string): string {
  const text = source
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图像] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[>*_~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (text || fallback).slice(0, 180)
}

function toolIcon(name: string): PaperPixelIconName {
  if (/read|file/.test(name)) return 'book'
  if (/search|find/.test(name)) return 'map'
  if (/spawn|agent|role/.test(name)) return 'companion'
  if (/question|ask/.test(name)) return 'scroll'
  if (/skill/.test(name)) return 'spark'
  return 'gear'
}

export function toolDisplayName(name: string, tools: readonly SenseToolInfo[] = []): string {
  return tools.find((tool) => tool.name === name)?.label?.trim() || name
}

function canBranchFrom(node: ExecutionNode): boolean {
  const fact = node.sourceFact
  if (!fact || fact.status !== 'committed' || fact.kind === 'system') return false
  if (!fact.content.trim() && !fact.toolCalls?.length) return false
  return !(fact.toolCalls ?? []).some(
    (call) => call.status === 'pending' || call.status === 'accepted',
  )
}

export interface FoldMemberCardOptions {
  title: string
  index: number
  total: number
  relatedEdges?: readonly ExecutionEdge[]
  selectedCallId?: string
  foldNode?: ExecutionNode
  senseTools?: readonly SenseToolInfo[]
}

function memberCardIcon(member: ExecutionFoldMember): PaperPixelIconName {
  const node = member.displayNode
  if (node.kind === 'tool-batch') return 'gear'
  if (node.kind === 'return') return 'chest'
  if (node.kind === 'dispatch' || node.kind === 'spawn') return 'seal'
  if (node.actor.kind === 'user' || node.kind === 'input') return 'adventurer'
  if (node.actor.kind === 'agent' && node.sourceChatId !== node.rootChatId) return 'companion'
  return 'magic'
}

/** Process members are semantic stages, not nested cards. */
function buildProcessStages(
  members: readonly ExecutionFoldMember[],
  options: FoldMemberCardOptions,
): PaperProcessStage[] {
  return members.map((member, memberIndex) => {
    const node = member.displayNode
    const calls = (toolBatchDetail(node)?.calls ?? [])
      .slice()
      .sort((a, b) => a.index - b.index || a.callId.localeCompare(b.callId))
      .map((call) => ({
        id: call.callId,
        call,
        label: toolDisplayName(call.name, options.senseTools),
        icon: toolIcon(call.name),
        status: call.status,
      }))
    const stageStatus =
      calls.at(-1)?.status ?? node.inputState ?? node.sourceFact?.status ?? node.status
    const cardOptions = {
      title: skinForNode(node).label,
      index: memberIndex,
      total: members.length,
      relatedEdges: options.relatedEdges,
      senseTools: options.senseTools,
    }
    return {
      id: member.id,
      index: memberIndex,
      node,
      icon: calls[0]?.icon ?? memberCardIcon(member),
      label: calls.map((call) => call.label).join('、') || skinForNode(node).label,
      status: statusLabel(stageStatus),
      tone: statusTone(stageStatus),
      summary: plainSummary(node.content || node.thinking || '', skinForNode(node).label),
      calls,
      cardOptions,
    }
  })
}

export function buildPaperGameCard(
  node: ExecutionNode,
  options: {
    title: string
    index: number
    total: number
    relatedEdges?: readonly ExecutionEdge[]
    selectedCallId?: string
    foldNode?: ExecutionNode
    senseTools?: readonly SenseToolInfo[]
  },
): PaperGameCardModel {
  const identity = cardIdentity(options.foldNode ?? node)
  const batch = toolBatchDetail(node)
  const selectedCall = selectedToolCall(batch?.calls ?? [], options.selectedCallId)
  const nodeParts = contentParts(node.content)
  const thinking = node.thinking?.trim() || node.sourceFact?.thinking?.trim() || ''
  const status = selectedCall?.status ?? node.inputState ?? node.sourceFact?.status ?? node.status
  const details: PaperDetailBlock[] = []
  let processStages: PaperProcessStage[] | undefined

  if (nodeParts.content) {
    details.push({
      id: 'content',
      kind: 'content',
      icon: node.actor.kind === 'user' ? 'ink' : 'quill',
      title: node.actor.kind === 'user' ? '冒险指令' : '正文卷轴',
      hint: plainSummary(nodeParts.content, '打开正文'),
      content: nodeParts.content,
      format: 'markdown',
    })
  }
  if (thinking) {
    details.push({
      id: 'thinking',
      kind: 'thinking',
      icon: 'spark',
      title: '秘法推演',
      hint: plainSummary(thinking, '查看思考过程'),
      content: thinking,
      format: 'markdown',
      tone: 'magic',
    })
  }
  if (selectedCall?.arguments.trim()) {
    const argumentFields = parseFieldViews(selectedCall.arguments, '工具参数')
    details.push({
      id: `${selectedCall.callId}:arguments`,
      kind: 'arguments',
      icon: 'map',
      title: '技能铭文',
      hint: plainSummary(selectedCall.arguments, '查看工具参数'),
      content: selectedCall.arguments,
      format: 'code',
      ...(argumentFields.length ? { fields: argumentFields } : {}),
    })
  }
  if (selectedCall?.result?.trim()) {
    const resultFields = parseFieldViews(selectedCall.result)
    details.push({
      id: `${selectedCall.callId}:result`,
      kind: 'result',
      icon: selectedCall.status === 'error' ? 'warning' : 'chest',
      title: selectedCall.status === 'error' ? '失败记录' : '技能产物',
      hint: plainSummary(selectedCall.result, '查看执行结果'),
      content: selectedCall.result,
      format: 'markdown',
      tone: selectedCall.status === 'error' ? 'warning' : 'success',
      ...(resultFields.length ? { fields: resultFields } : {}),
    })
  }
  if (options.foldNode?.fold?.members.length) {
    processStages = buildProcessStages(options.foldNode.fold.members, options)
  }

  const skills = (batch?.calls ?? []).map((call) => ({
    id: call.callId,
    icon: toolIcon(call.name),
    label: toolDisplayName(call.name, options.senseTools),
    status: call.status,
  }))
  const relationCount = options.relatedEdges?.length ?? 0
  const termination = node.sourceFact?.termination
    ? terminationDisplay(node.sourceFact.termination)
    : undefined
  const summarySource = nodeParts.description || nodeParts.content || thinking
  const stats: PaperCardStat[] = [
    { id: 'status', icon: 'shield', label: '状态', value: statusLabel(status) },
    ...(skills.length
      ? [{ id: 'skills', icon: 'gear' as const, label: '技能', value: `${skills.length} 项` }]
      : []),
    ...(options.foldNode?.fold?.members.length
      ? [
          {
            id: 'pages',
            icon: 'book' as const,
            label: '过程',
            value: `${options.foldNode.fold.members.length} 页`,
          },
        ]
      : []),
    { id: 'links', icon: 'map', label: '关联', value: `${relationCount} 条` },
  ]

  return {
    id: node.id,
    ...identity,
    title:
      (selectedCall
        ? toolDisplayName(selectedCall.name, options.senseTools)
        : options.title.trim()) || skinForNode(node).label,
    status: statusLabel(status),
    statusTone: statusTone(status),
    time: formatTime(node.createdAt),
    summary: plainSummary(summarySource, batch ? '工具技能记录' : '这张卡片没有留下正文。'),
    sequence: `${String(options.index + 1).padStart(2, '0')} / ${String(options.total).padStart(2, '0')}`,
    stats: stats.slice(0, 3),
    details,
    ...(processStages ? { processStages } : {}),
    skills,
    ...(selectedCall ? { selectedSkillId: selectedCall.callId } : {}),
    ...(termination ? { termination } : {}),
    canBranch: canBranchFrom(node),
  }
}
