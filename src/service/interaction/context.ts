import { getChat, getChatPreviews, getRootChatId } from '@/db/chat.js'
import { safeJsonParse } from '@/utils/json.js'

export interface InteractionContextSnapshot {
  taskGoal: string
  agent: string
  rationale: string
  nextStep: string
  source: 'agent' | 'fallback'
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function baseContext(chatId: string): Pick<InteractionContextSnapshot, 'taskGoal' | 'agent'> {
  const chat = getChat(chatId)
  const root = getChat(getRootChatId(chatId))
  const meta = chat?.metadata ? safeJsonParse<{ type?: string }>(chat.metadata, {}) : {}
  const taskGoal = root ? getChatPreviews([root]).get(root.id)?.preview : undefined
  return {
    taskGoal: clip(taskGoal || '当前任务', 120),
    agent: clip(chat?.parent_chat_id ? meta.type || '子 Agent' : '主 Agent', 40),
  }
}

export function questionInteractionContext(
  chatId: string,
  input: { rationale?: string; nextStep?: string },
): InteractionContextSnapshot {
  const rationale = clip(input.rationale || '', 240)
  const nextStep = clip(input.nextStep || '', 240)
  return {
    ...baseContext(chatId),
    rationale: rationale || 'Agent 需要你的选择才能继续当前任务。',
    nextStep: nextStep || '提交回答后，Agent 将根据你的选择继续执行。',
    source: rationale && nextStep ? 'agent' : 'fallback',
  }
}

function targetOf(argumentsJson: string): string | undefined {
  const args = safeJsonParse<Record<string, unknown>>(argumentsJson, {})
  for (const key of ['path', 'file', 'url', 'command', 'name', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return clip(value, 100)
  }
  return undefined
}

export function approvalInteractionContext(
  chatId: string,
  input: { senseName: string; senseDescription?: string; arguments: string },
): InteractionContextSnapshot {
  const target = targetOf(input.arguments)
  const capability = clip(input.senseDescription || input.senseName || '受控操作', 120)
  return {
    ...baseContext(chatId),
    rationale: target
      ? `Agent 准备执行“${capability}”，目标是 ${target}，需要你确认风险。`
      : `Agent 准备执行“${capability}”，需要你确认风险。`,
    nextStep: `接受后立即执行 ${input.senseName}；拒绝后工具不会执行，Agent 将收到拒绝结果。`,
    source: 'fallback',
  }
}
