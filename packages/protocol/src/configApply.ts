import { z } from 'zod'

export const CONFIG_APPLY_VERSION = 2 as const
export const CONFIG_APPLY_CHANGED = 'config.apply.changed' as const
export const ConfigImpactSchema = z.object({
  resource: z.string().min(1),
  paths: z.array(z.string()),
  semanticPaths: z.array(z.string()),
  semantic: z.boolean(),
  boundary: z.enum(['operation', 'run', 'tree', 'resource', 'restart', 'unsupported']),
  status: z.enum(['applied', 'pending', 'failed']),
  reason: z.string().optional(),
  appliedRevision: z.string(),
})
export const ConfigApplyStateSchema = z.object({
  protocolVersion: z.literal(CONFIG_APPLY_VERSION),
  savedRevision: z.string(),
  appliedRevision: z.string(),
  status: z.enum(['applied', 'pending', 'failed']),
  impacts: z.array(ConfigImpactSchema),
  restart: z.object({ required: z.boolean(), status: z.enum(['none', 'pending', 'manual']) }),
})
export const ConfigSaveResultSchema = ConfigApplyStateSchema.extend({
  baseRevision: z.string(),
  candidateRevisionId: z.string(),
  warnings: z.array(z.string()),
})
export const ConfigPreviewSchema = z.object({
  protocolVersion: z.literal(CONFIG_APPLY_VERSION),
  baseRevision: z.string(),
  previewToken: z.string(),
  impacts: z.array(ConfigImpactSchema),
  destructiveTargets: z.array(z.string()),
  policy: z.literal('wait'),
})
export const HooksDraftSchema = z.partialRecord(
  z.enum([
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreLLMRequest',
    'PostLLMResponse',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'PreCompact',
    'PostCompact',
  ]),
  z.array(
    z
      .object({
        command: z.string().trim().min(1),
        matcher: z.string().optional(),
        if: z.string().optional(),
        timeout: z.number().positive().optional(),
      })
      .strict(),
  ),
)
export type ConfigApplyState = z.infer<typeof ConfigApplyStateSchema>
export type ConfigImpact = z.infer<typeof ConfigImpactSchema>
export type ConfigSaveResult = z.infer<typeof ConfigSaveResultSchema>
export type ConfigPreview = z.infer<typeof ConfigPreviewSchema>
export type HooksDraft = z.infer<typeof HooksDraftSchema>
export interface ConfigApplyRequest<T> {
  protocolVersion: typeof CONFIG_APPLY_VERSION
  expectedBaseRevision: string
  candidate: T
  hooks?: HooksDraft
}
export interface ConfigSaveRequest<T> extends ConfigApplyRequest<T> {
  requestId: string
  previewToken?: string
  policy?: 'wait'
}
