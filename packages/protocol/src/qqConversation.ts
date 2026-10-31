import { z } from 'zod'

export const QQStyleSchema = z.enum(['concise', 'casual', 'playful'])
const fields = {
  mode: z.enum(['followup', 'proactive']),
  initiative: z.enum(['quiet', 'balanced', 'lively']),
  style: QQStyleSchema,
  customStyle: z.string().max(2000),
}
export const QQConversationOverrideSchema = z.object(fields).partial().strict()
export const QQConversationDefaults = { mode: 'followup' as const, initiative: 'balanced' as const, style: 'casual' as const, customStyle: '' }
export const QQConversationSchema = z.object({
  defaults: z.object(fields).strict().default(QQConversationDefaults),
  groups: z.record(z.string().regex(/^[1-9]\d{0,19}$/), QQConversationOverrideSchema).default({}),
  privateStyle: z.object({ style: QQStyleSchema.default('casual'), customStyle: fields.customStyle.default('') }).strict().default({ style: 'casual', customStyle: '' }),
  proactive: z.object({
    batchWaitMs: z.number().int().min(0).max(10000).default(3000),
    minCheckIntervalMs: z.number().int().min(1000).max(3600000).default(30000),
    maxChecksPerHour: z.number().int().min(1).max(3600).default(60),
    minReplyIntervalMs: z.number().int().min(0).max(3600000).default(60000),
    contextReadLimit: z.number().int().min(0).max(5).default(2),
  }).strict().default({ batchWaitMs: 3000, minCheckIntervalMs: 30000, maxChecksPerHour: 60, minReplyIntervalMs: 60000, contextReadLimit: 2 }),
}).strict().superRefine((value, ctx) => {
  if (value.proactive.minCheckIntervalMs < value.proactive.batchWaitMs)
    ctx.addIssue({ code: 'custom', path: ['proactive', 'minCheckIntervalMs'], message: '观察间隔不能短于合并等待' })
}).transform(value => ({ ...value, groups: Object.fromEntries(Object.entries(value.groups).filter(([, entry]) => Object.keys(entry).length)) }))
export const QQConversationDefault = QQConversationSchema.parse({})
export const QQLearningSchema = z.object({
  maxCallsPerHour: z.number().int().min(1).max(3600).default(60),
  maxPending: z.number().int().min(1).max(1000).default(100),
}).strict()

export function resolveConversationPolicy(config: { conversation: z.infer<typeof QQConversationSchema> }, target: string) {
  const { defaults, groups, privateStyle } = config.conversation
  if (target.startsWith('private:user:')) return { effective: { ...defaults, mode: 'followup' as const, ...privateStyle },
    origins: { mode: 'private', initiative: 'default', style: 'private', customStyle: 'private' } }
  const override = groups[target.slice(6)] ?? {}
  return { effective: { ...defaults, ...override }, origins: Object.fromEntries(Object.keys(defaults).map(key =>
    [key, Object.hasOwn(override, key) ? 'group' : 'default'])) }
}
