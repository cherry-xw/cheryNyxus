import type { WorkflowCall, WorkflowSnapshot } from '@chery/protocol'
import type { MessageRow } from '@/db/chat.js'
import type { LLMResponse } from '@/core/message/adapter'

export function skillActivation(content: string): string | undefined {
  return /^"([^"\r\n]+)"技能已激活。以下是完整指令，请严格遵守：\r?\n\r?\n\S[\s\S]*/.exec(
    content,
  )?.[1]
}

export function workflowCallStatus(
  content: string | null,
  revoked = false,
): WorkflowCall['status'] {
  if (revoked) return 'cancelled'
  if (!content) return 'unknown'
  if (content.startsWith('被拒绝:')) return 'rejected'
  if (content.startsWith('感官执行失败：') || content.startsWith('Error: skill ')) return 'failed'
  return 'completed'
}

export function effectiveSkillCount(
  messages: Array<
    Pick<MessageRow, 'id' | 'role' | 'content' | 'sense_calls' | 'revoked' | 'replace_state'>
  >,
): Pick<WorkflowSnapshot['resources'], 'loadedSkillCount' | 'loadedSkillsComplete'> {
  const calls = new Map<string, string>()
  let complete = true
  for (const message of messages) {
    if (message.revoked || !message.sense_calls) continue
    try {
      for (const call of JSON.parse(message.sense_calls) as Array<{ id: string; name: string }>)
        calls.set(call.id, call.name)
    } catch {
      complete = false
    }
  }
  const loaded = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'sense' || message.revoked || message.replace_state) continue
    if (!calls.has(message.id)) {
      complete = false
      continue
    }
    if (calls.get(message.id) !== 'skill') continue
    const name = skillActivation(message.content ?? '')
    if (name) loaded.add(name)
    else if (
      message.content &&
      !message.content.startsWith('Error: skill ') &&
      !message.content.startsWith('被拒绝:') &&
      !message.content.startsWith('感官执行失败：')
    )
      complete = false
  }
  return { loadedSkillCount: loaded.size, loadedSkillsComplete: complete }
}

export function memoryRows(messages: LLMResponse[]): Parameters<typeof effectiveSkillCount>[0] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    sense_calls: message.senseCalls ? JSON.stringify(message.senseCalls) : null,
    revoked: message.revoked ? 1 : 0,
    replace_state: message.replace?.state ? 1 : 0,
  }))
}
