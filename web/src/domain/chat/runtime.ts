/** 每轮可切换的 runtime selection。 */
export interface RuntimeSelection {
  brain: string
  senseGroup: string
  mcpServers?: string[]
}

export interface RuntimeProvenance extends RuntimeSelection {
  brainModel?: string
  brainProvider?: string
}

export interface SessionRuntimeSelection {
  primary: RuntimeSelection
  roles: Record<string, RuntimeSelection>
}
