export interface AgentLoadingEntry {
  chatId: string
  name: string
  face: string
  running: boolean
}

export type RunningAgentSnapshot = Omit<AgentLoadingEntry, 'running'>

/**
 * 把当前运行 Agent 合入一个批次；已进入批次但本轮不再运行的项保留为“已完成等待”。
 */
export function reconcileAgentLoadingEntries(
  previous: readonly AgentLoadingEntry[],
  running: readonly RunningAgentSnapshot[],
): AgentLoadingEntry[] {
  const currentIds = new Set(running.map((entry) => entry.chatId))
  const entries = new Map(previous.map((entry) => [entry.chatId, { ...entry, running: false }]))
  for (const entry of running) {
    const existing = entries.get(entry.chatId)
    entries.set(entry.chatId, { ...(existing ?? entry), ...entry, running: true })
  }
  return [...entries.values()].map((entry) => ({
    ...entry,
    running: currentIds.has(entry.chatId),
  }))
}
