import { z } from 'zod'

export const SettingsRequiredTextSchema = z.string().refine(
  value => !!value.trim() && !/^<[^>]*>$/.test(value.trim()), '请填写非空内容，不能使用模板占位符',
)
const positiveInteger = z.number().int().positive()
const duration = z.number().nonnegative()
export const SettingsThresholdSchema = z.discriminatedUnion('unit', [
  z.looseObject({ unit: z.literal('tokens'), value: z.number().nonnegative() }),
  z.looseObject({ unit: z.literal('percent'), value: z.number().min(0).max(1) }),
])
export const SettingsGlobalSchema = z.looseObject({
  thinking: z.boolean(), stream: z.boolean(), supervision: z.enum(['auto', 'smart', 'manual']),
  llm_request_timeout_ms: duration.optional(), sense_execute_timeout: duration.optional(),
  approval_timeout: duration.optional(), approval_hard_timeout: duration.optional(), disconnect_grace_ms: duration.optional(),
  maxLoopCount: positiveInteger.optional(), tree_full_render_threshold: z.number().int().nonnegative().optional(),
  textEditor: SettingsRequiredTextSchema.optional(),
  history_recall: z.looseObject({ max_output_chars: positiveInteger.optional() }).optional(),
  watchdog: z.looseObject({ timeout_ms: duration.optional(), wake_on_timeout: z.boolean().optional() }).optional(),
  logger: z.looseObject({ level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(), output: z.array(z.enum(['console', 'file'])).optional(), timestamp: z.boolean().optional(), location: z.boolean().optional(), format: z.enum(['plain', 'json']).optional() }).optional(),
  file_compression: z.looseObject({ truncate_threshold: positiveInteger.optional(), truncate_preview_lines: positiveInteger.optional(), drain_preview_count: positiveInteger.optional(), log_file_extensions: z.array(z.string()).optional() }).optional(),
  command: z.looseObject({ warn: SettingsThresholdSchema.optional(), auto: SettingsThresholdSchema.optional(), min_context_limit: duration.optional(), safety_margin: duration.optional() }).optional(),
})
const memoryLimits = z.looseObject({ max_count: positiveInteger.optional(), max_chars: positiveInteger.optional() })
export const SettingsMemorySchema = z.looseObject({ global: memoryLimits.optional(), workspace: memoryLimits.optional() })
export const SettingsMcpServerSchema = z.looseObject({
  transport: z.enum(['stdio', 'streamable-http']), command: z.string().optional(),
  args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(), supervision: z.enum(['auto', 'smart', 'manual']).optional(),
}).superRefine((server, ctx) => {
  const field = server.transport === 'stdio' ? 'command' : 'url'
  if (!server[field]?.trim()) ctx.addIssue({ code: 'custom', path: [field], message: '此传输方式必须填写此项' })
  else if (field === 'url' && !server.url!.startsWith('$')) {
    try { if (!['http:', 'https:'].includes(new URL(server.url!).protocol)) throw new Error() }
    catch { ctx.addIssue({ code: 'custom', path: ['url'], message: '请填写有效的 HTTP(S) 地址' }) }
  }
})

export const SETTINGS_UNSET_FIELDS = {
  brains: ['url', 'protocol', 'key', 'thinking', 'rpm', 'fullUrl', 'mock', 'capabilities', 'hooks', 'anthropicCompat'],
  presets: ['detailRole', 'workspace', 'rule', 'schedule', 'shadows', 'roleOverrides'],
  'sense-groups': [],
} as const
export function settingsUnsetErrors(kind: keyof typeof SETTINGS_UNSET_FIELDS, value: unknown, unset: readonly string[] = []): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const field of unset) {
    if (!(SETTINGS_UNSET_FIELDS[kind] as readonly string[]).includes(field)) errors.push(`${field} 不能恢复默认`)
    if (seen.has(field)) errors.push(`${field} 重复删除`)
    seen.add(field)
    if (value && typeof value === 'object' && Object.hasOwn(value, field)) errors.push(`${field} 不能同时赋值和恢复默认`)
  }
  return errors
}
