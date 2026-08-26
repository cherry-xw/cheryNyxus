export interface AgentLoadingEntry {
  chatId: string
  name: string
  face: string
  isMaster: boolean
  running: boolean
}

export type RunningAgentSnapshot = Omit<AgentLoadingEntry, 'running'>

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
