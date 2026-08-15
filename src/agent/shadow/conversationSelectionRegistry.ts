export interface ConversationSelection {
  chatId: string | null
  confidence: number
  reason: string
}

interface ConversationSelectionRun {
  candidates: Set<string>
  result?: ConversationSelection
}

const runs = new Map<string, ConversationSelectionRun>()

export function registerConversationSelectionRun(runId: string, candidateChatIds: string[]): void {
  if (runs.has(runId)) throw new Error(`Shadow run "${runId}" 已存在`)
  runs.set(runId, { candidates: new Set(candidateChatIds) })
}

export function recordConversationSelection(runId: string, selection: ConversationSelection): void {
  const run = runs.get(runId)
  if (!run) throw new Error('会话路由 Shadow 已结束或不存在')
  if (run.result) throw new Error('本次会话路由已经完成选择')
  if (selection.chatId !== null && !run.candidates.has(selection.chatId)) {
    throw new Error(`chatId "${selection.chatId}" 不在本次候选快照中`)
  }
  run.result = selection
}

export function getConversationSelection(runId: string): ConversationSelection | undefined {
  return runs.get(runId)?.result
}

export function clearConversationSelectionRun(runId: string): void {
  runs.delete(runId)
}

export function hasConversationSelectionRun(runId: string): boolean {
  return runs.has(runId)
}
