/**
 * 标题栏会话状态条纯逻辑（无 Vue 依赖，node 环境可测）。
 * 从 taskOverview store 的 tasks 中选出当前预设的活跃会话（running/needs_user），
 * 投影为 strip icon 所需字段，并处理溢出截断。
 */
import type { TaskOverview } from '@/application/backend/public'

/** strip 单 icon 的投影数据。 */
export interface SessionStripItem {
  rootChatId: string
  title: string
  lastUserPrompt?: string
  status: TaskOverview['status']
  currentStep?: string
  currentStepKind?: 'model' | 'tool'
  pendingCount: number
  updatedAt: number
}

/** 标题栏 icon 数量上限（超过折叠为「+N」，防窄窗溢出）。 */
export const SESSION_STRIP_MAX_ICONS = 6

function matchesPreset(
  task: TaskOverview,
  presetId?: string,
  presetName?: string,
): boolean {
  if (!presetId && !presetName) return true
  return (
    (presetId ? task.presetId === presetId : false) ||
    (presetName ? task.preset === presetName : false)
  )
}

function project(task: TaskOverview): SessionStripItem {
  // 主 Agent 优先取（agents[0] 通常为 root 自身）；currentStep 以 root agent 为准。
  const rootAgent = task.agents.find((agent) => agent.chatId === task.rootChatId)
  return {
    rootChatId: task.rootChatId,
    title: task.title,
    ...(task.lastUserPrompt ? { lastUserPrompt: task.lastUserPrompt } : {}),
    status: task.status,
    ...(rootAgent?.currentStep ? { currentStep: rootAgent.currentStep } : {}),
    ...(rootAgent?.currentStepKind ? { currentStepKind: rootAgent.currentStepKind } : {}),
    pendingCount: task.pendingCount,
    updatedAt: task.updatedAt,
  }
}

/**
 * 选出当前预设活跃会话并截断。
 * 顺序沿用 store 的 STATUS_PRIORITY（needs_user < running），同状态按 updatedAt 倒序。
 * 当前会话（currentChatId）无论状态强制置顶入列并高亮——strip 必须标出「当前打开的是哪个会话」；
 * 非活跃当前会话占一个槽位，相应活跃溢出 +1。
 */
export function pickStripTasks(
  tasks: TaskOverview[],
  presetId?: string,
  presetName?: string,
  currentChatId?: string,
  maxIcons = SESSION_STRIP_MAX_ICONS,
): { items: SessionStripItem[]; overflowCount: number } {
  const active = tasks
    .filter((task) => task.status === 'running' || task.status === 'needs_user')
    .filter((task) => matchesPreset(task, presetId, presetName))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(project)
  const currentInActive = !!currentChatId && active.some((item) => item.rootChatId === currentChatId)

  let items: SessionStripItem[]
  let overflowCount: number
  if (currentInActive) {
    items = active.slice(0, maxIcons)
    overflowCount = Math.max(0, active.length - maxIcons)
  } else {
    const currentTask = currentChatId
      ? tasks.find((task) => task.rootChatId === currentChatId)
      : undefined
    if (currentTask) {
      // 非活跃当前会话占一个槽位置顶，活跃溢出 +1。
      items = [project(currentTask), ...active.slice(0, maxIcons - 1)]
      overflowCount = Math.max(0, active.length - (maxIcons - 1))
    } else {
      items = active.slice(0, maxIcons)
      overflowCount = Math.max(0, active.length - maxIcons)
    }
  }
  return { items, overflowCount }
}

/** hover tooltip 三要素组装（标题 / 最后一次提问 / 当前节点类型），缺失字段回退占位。 */
export function buildStripTooltip(
  item: SessionStripItem,
  fallbackNode = '—',
): { title: string; lastPrompt: string; currentNode: string } {
  return {
    title: item.title || '未命名会话',
    lastPrompt: item.lastUserPrompt || '（暂无提问）',
    currentNode: currentNodeLabel(item, fallbackNode),
  }
}

/** 当前节点展示文案：currentStep 优先；缺省按 currentStepKind（model=思考中 / tool=执行工具），再无则回退。 */
export function currentNodeLabel(item: SessionStripItem, fallback = '—'): string {
  if (item.currentStep) return item.currentStep
  if (item.currentStepKind === 'model') return '思考中'
  if (item.currentStepKind === 'tool') return '执行工具'
  return fallback
}
