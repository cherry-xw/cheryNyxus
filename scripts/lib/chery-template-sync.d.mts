export interface TemplateSyncReport {
  created: boolean
  copied: string[]
  updated: string[]
  preserved: Array<{ path: string; reason: string }>
  configMigrated: boolean
  warnings: string[]
}

export function ensureEnvSeed(input: { envExamplePath: string; runtimeRoot: string }): {
  created: boolean
  target: string
  warning?: string
}

export function syncCheryTemplate(input: {
  templateDir: string
  runtimeRoot: string
}): TemplateSyncReport
