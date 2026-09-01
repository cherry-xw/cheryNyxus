import { createHash } from 'node:crypto'
import { z } from 'zod'
import { readRawConfig, type ConfigRaw } from '@/utils/config.js'

const nonEmptyString = z.string().min(1)
const stableId = (prefix: 'role' | 'preset') =>
  z.string().regex(new RegExp(`^${prefix}-[a-zA-Z0-9_-]{8,}$`), `必须是合法的 ${prefix} 稳定 ID`)

const mediaCapabilitiesSchema = z.object({
  image: z.boolean().optional(),
  video: z.boolean().optional(),
  audio: z.boolean().optional(),
})

/** AI 可写的完整 brain 资源。所有已支持字段都有明确类型，禁止 unknown 值穿透。 */
export const brainConfigOperationSchema = z.object({
  url: z.string().optional(),
  model: nonEmptyString,
  key: z.string().optional(),
  thinking: nonEmptyString.optional(),
  provider: nonEmptyString,
  protocol: z
    .enum([
      'openai-chat-completions',
      'openai-responses',
      'anthropic-messages',
      'ollama-chat',
      'mock',
    ])
    .optional(),
  rpm: z.number().positive().optional(),
  fullUrl: z.boolean().optional(),
  mock: z
    .object({
      enabled: z.boolean().optional(),
      file: nonEmptyString,
      chunkDelayMs: z.number().nonnegative().optional(),
      preRespondMs: z.number().nonnegative().optional(),
    })
    .optional(),
  contextLimit: z.number().positive().optional(),
  capabilities: z
    .object({
      toolCall: z.boolean().optional(),
      input: mediaCapabilitiesSchema.optional(),
      generate: mediaCapabilitiesSchema.optional(),
    })
    .optional(),
  hooks: z.string().optional(),
  anthropicCompat: z.object({ official: z.boolean().optional() }).optional(),
})

const permissionEffectSchema = z.enum(['inherit', 'allow', 'ask', 'deny'])
const rolePermissionSchema = z.object({
  template: z.enum(['read-only', 'workspace-developer', 'supervised', 'trusted']),
  tools: z.record(z.string(), permissionEffectSchema).optional(),
  filesystem: z
    .object({
      read: z.enum(['deny', 'workspace', 'any']).optional(),
      write: z.enum(['deny', 'workspace', 'any-with-approval']).optional(),
    })
    .optional(),
  commands: z
    .object({
      shells: z.array(z.enum(['bash', 'powershell'])).optional(),
      maxSandboxMode: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      categories: z.record(z.string(), permissionEffectSchema).optional(),
    })
    .optional(),
  mcp: z
    .object({
      default: permissionEffectSchema.optional(),
      tools: z.record(z.string(), permissionEffectSchema).optional(),
    })
    .optional(),
  spawn: z
    .object({
      allowedRoles: z.array(z.string()).optional(),
      effect: permissionEffectSchema.optional(),
    })
    .optional(),
})

/** AI 可写的完整 role 资源。put 更新时必须携带 get 返回的稳定 id。 */
export const roleConfigOperationSchema = z.object({
  id: stableId('role').optional(),
  kind: z.enum(['role', 'shadow']).optional(),
  brain: nonEmptyString,
  avatar: z.string().max(24).optional(),
  description: z.string().optional(),
  mentionable: z.boolean().optional(),
  senseGroup: nonEmptyString,
  mcpServers: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  permissions: rolePermissionSchema.optional(),
  lock: z.boolean().optional(),
})

/** AI 可写的完整 preset 资源。 */
export const presetConfigOperationSchema = z.object({
  id: stableId('preset').optional(),
  shadows: z.object({ conversationRouting: z.string().optional() }).optional(),
  detailRole: z.string().optional(),
  leader: nonEmptyString,
  roles: z.array(z.string()).optional(),
  mediaImage: z.string().optional(),
  mediaVideo: z.string().optional(),
  mediaAudio: z.string().optional(),
  workspace: z.string().optional(),
  schedule: z
    .object({
      cron: nonEmptyString,
      task: nonEmptyString,
      enabled: z.boolean().optional(),
    })
    .optional(),
  rule: z.string().optional(),
})

const putBrainSchema = z.object({
  op: z.literal('putBrain'),
  name: nonEmptyString,
  brain: brainConfigOperationSchema,
})
const removeBrainSchema = z.object({
  op: z.literal('removeBrain'),
  name: nonEmptyString,
})
const putRoleSchema = z.object({
  op: z.literal('putRole'),
  name: nonEmptyString,
  role: roleConfigOperationSchema,
})
const removeRoleSchema = z.object({
  op: z.literal('removeRole'),
  name: nonEmptyString,
  expectedId: stableId('role').optional(),
})
const putPresetSchema = z.object({
  op: z.literal('putPreset'),
  name: nonEmptyString,
  preset: presetConfigOperationSchema,
})
const removePresetSchema = z.object({
  op: z.literal('removePreset'),
  name: nonEmptyString,
  expectedId: stableId('preset').optional(),
})
const putSenseGroupSchema = z.object({
  op: z.literal('putSenseGroup'),
  name: nonEmptyString,
  senses: z.array(nonEmptyString),
})
const removeSenseGroupSchema = z.object({
  op: z.literal('removeSenseGroup'),
  name: nonEmptyString,
})

/** 增量操作使用资源级 put/remove，不开放任意 JSON path，避免越界字段与类型退化。 */
export const configOperationSchema = z.discriminatedUnion('op', [
  putBrainSchema,
  removeBrainSchema,
  putRoleSchema,
  removeRoleSchema,
  putPresetSchema,
  removePresetSchema,
  putSenseGroupSchema,
  removeSenseGroupSchema,
])

export const configOperationsSchema = z.array(configOperationSchema).min(1).max(50)
export type ConfigOperation = z.infer<typeof configOperationSchema>

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * AI 乐观并发令牌。与语义修订 fingerprint 不同，它覆盖 config.yaml 的全部可编辑字段，
 * 包括连接配置和真实凭证值；仅返回单向哈希，不泄露凭证。
 */
export function getConfigBaseRevision(raw: ConfigRaw = readRawConfig()): string {
  return `config-${createHash('sha256').update(stableStringify(raw)).digest('hex')}`
}

export type ApplyConfigOperationsResult =
  { ok: true; candidate: ConfigRaw } | { ok: false; errors: string[] }

/** 把一组已强类型校验的操作原子地应用到磁盘快照副本；失败时不返回半成品。 */
export function applyConfigOperations(
  base: ConfigRaw,
  operations: readonly ConfigOperation[],
): ApplyConfigOperationsResult {
  const candidate = structuredClone(base)
  const errors: string[] = []

  for (const operation of operations) {
    switch (operation.op) {
      case 'putBrain':
        candidate.llm ??= { brain: {} }
        candidate.llm.brain ??= {}
        candidate.llm.brain[operation.name] = structuredClone(operation.brain)
        break
      case 'removeBrain':
        if (!candidate.llm?.brain?.[operation.name]) {
          errors.push(`llm.brain.${operation.name} 不存在，无法删除`)
        } else {
          delete candidate.llm.brain[operation.name]
        }
        break
      case 'putRole':
        candidate.roles ??= {}
        candidate.roles[operation.name] = structuredClone(operation.role)
        candidate.roles[operation.name]!.id ??= base.roles?.[operation.name]?.id
        break
      case 'removeRole': {
        const current = candidate.roles?.[operation.name]
        if (!current) {
          errors.push(`roles.${operation.name} 不存在，无法删除`)
        } else if (operation.expectedId && current.id !== operation.expectedId) {
          errors.push(
            `roles.${operation.name}.id 已变化（期望 ${operation.expectedId}，实际 ${current.id ?? '无'}）`,
          )
        } else {
          delete candidate.roles![operation.name]
        }
        break
      }
      case 'putPreset':
        candidate.presets ??= {}
        candidate.presets[operation.name] = structuredClone(operation.preset)
        candidate.presets[operation.name]!.id ??= base.presets?.[operation.name]?.id
        break
      case 'removePreset': {
        const current = candidate.presets?.[operation.name]
        if (!current) {
          errors.push(`presets.${operation.name} 不存在，无法删除`)
        } else if (operation.expectedId && current.id !== operation.expectedId) {
          errors.push(
            `presets.${operation.name}.id 已变化（期望 ${operation.expectedId}，实际 ${current.id ?? '无'}）`,
          )
        } else {
          delete candidate.presets![operation.name]
        }
        break
      }
      case 'putSenseGroup':
        candidate.sense_groups ??= {}
        candidate.sense_groups[operation.name] = [...operation.senses]
        break
      case 'removeSenseGroup':
        if (!candidate.sense_groups?.[operation.name]) {
          errors.push(`sense_groups.${operation.name} 不存在，无法删除`)
        } else {
          delete candidate.sense_groups[operation.name]
        }
        break
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, candidate }
}
