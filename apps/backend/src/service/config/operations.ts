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

// ---- 表驱动操作工厂：4 对 put/remove 由同一套工厂生成（schema 与 apply 共用资源描述） ----

/** 单个资源的 put/remove 操作描述（表驱动，新增资源种类只需加一行）。 */
interface ResourceOpSpec {
  /** 操作名（camelCase，如 'brain' → putBrain / removeBrain）。 */
  resource: string
  /** zod schema 厂：生成该资源 put 操作的附加字段。 */
  putPayload?: z.ZodRawShape
  /** 资源在 ConfigRaw 中的容器取值器。 */
  getContainer: (candidate: ConfigRaw) => Record<string, unknown> | undefined
  /** 资源在 ConfigRaw 中的容器惰性初始化（put 前调用）。 */
  ensureContainer: (candidate: ConfigRaw) => Record<string, unknown>
  /** put 时写值的取值器（多数资源 structuredClone(payload)；数组类可浅拷贝）。 */
  takePutValue: (payload: Record<string, unknown>) => unknown
  /** put 时的 payload 字段名（如 'brain' / 'role' / 'preset' / 'senses'）。 */
  payloadField: string
  /** put 时保留既有稳定 id（role/preset 需要幂等 id）。 */
  preserveId?: {
    /** 既有 id 的读取器（base 快照侧）。 */
    baseId: (base: ConfigRaw, name: string) => string | undefined
  }
  /** remove 时的乐观并发校验（role/preset 带 expectedId）。 */
  expectedId?: {
    baseId: (base: ConfigRaw, name: string) => string | undefined
    /** 错误消息中的资源路径前缀（如 'roles' / 'presets'）。 */
    errorPath: string
  }
  /** remove 错误消息中的资源路径前缀（无 expectedId 的资源用）。 */
  removeErrorPath: string
  /** remove 错误消息中的资源路径前缀（candidate 侧实际路径，如 'llm.brain'）。 */
  missingErrorPath: string
}

function makePutSchema(resource: string, payload: z.ZodRawShape = {}) {
  return z.object({ op: z.literal(`put${capitalize(resource)}`), name: nonEmptyString, ...payload })
}
function makeRemoveSchema(resource: string, payload: z.ZodRawShape = {}) {
  return z.object({
    op: z.literal(`remove${capitalize(resource)}`),
    name: nonEmptyString,
    ...payload,
  })
}
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const RESOURCE_OPS: ResourceOpSpec[] = [
  {
    resource: 'brain',
    payloadField: 'brain',
    getContainer: (c) => c.llm?.brain,
    ensureContainer: (c) => {
      c.llm ??= { brain: {} }
      c.llm.brain ??= {}
      return c.llm.brain
    },
    takePutValue: (payload) => structuredClone(payload),
    removeErrorPath: 'llm.brain',
    missingErrorPath: 'llm.brain',
  },
  {
    resource: 'role',
    payloadField: 'role',
    getContainer: (c) => c.roles,
    ensureContainer: (c) => (c.roles ??= {}),
    takePutValue: (payload) => structuredClone(payload),
    preserveId: { baseId: (base, name) => base.roles?.[name]?.id },
    expectedId: {
      baseId: (base, name) => base.roles?.[name]?.id,
      errorPath: 'roles',
    },
    removeErrorPath: 'roles',
    missingErrorPath: 'roles',
  },
  {
    resource: 'preset',
    payloadField: 'preset',
    getContainer: (c) => c.presets,
    ensureContainer: (c) => (c.presets ??= {}),
    takePutValue: (payload) => structuredClone(payload),
    preserveId: { baseId: (base, name) => base.presets?.[name]?.id },
    expectedId: {
      baseId: (base, name) => base.presets?.[name]?.id,
      errorPath: 'presets',
    },
    removeErrorPath: 'presets',
    missingErrorPath: 'presets',
  },
  {
    resource: 'senseGroup',
    payloadField: 'senses',
    getContainer: (c) => c.sense_groups,
    ensureContainer: (c) => (c.sense_groups ??= {}),
    takePutValue: (payload) => [...(payload as unknown as string[])],
    removeErrorPath: 'sense_groups',
    missingErrorPath: 'sense_groups',
  },
]

const putBrainSchema = makePutSchema('brain', { brain: brainConfigOperationSchema })
const removeBrainSchema = makeRemoveSchema('brain')
const putRoleSchema = makePutSchema('role', { role: roleConfigOperationSchema })
const removeRoleSchema = makeRemoveSchema('role', { expectedId: stableId('role').optional() })
const putPresetSchema = makePutSchema('preset', { preset: presetConfigOperationSchema })
const removePresetSchema = makeRemoveSchema('preset', { expectedId: stableId('preset').optional() })
const putSenseGroupSchema = makePutSchema('senseGroup', { senses: z.array(nonEmptyString) })
const removeSenseGroupSchema = makeRemoveSchema('senseGroup')

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
    const verb = operation.op.startsWith('put') ? 'put' : 'remove'
    const resource = operation.op.slice(verb.length)
    const spec = RESOURCE_OPS.find(
      (entry) => entry.resource.toLowerCase() === resource.toLowerCase(),
    )
    if (!spec) continue

    if (verb === 'put') {
      const container = spec.ensureContainer(candidate)
      const payload = (operation as unknown as Record<string, unknown>)[
        spec.payloadField
      ] as Record<string, unknown>
      container[operation.name] = spec.takePutValue(payload)
      const written = container[operation.name] as { id?: string } | undefined
      if (spec.preserveId && written && typeof written === 'object') {
        written.id ??= spec.preserveId.baseId(base, operation.name)
      }
      continue
    }

    const container = spec.getContainer(candidate)
    const current = container?.[operation.name]
    if (!current) {
      errors.push(`${spec.missingErrorPath}.${operation.name} 不存在，无法删除`)
      continue
    }
    if (spec.expectedId) {
      const expectedId = (operation as unknown as Record<string, unknown>).expectedId as
        | string
        | undefined
      const currentId = (current as { id?: string }).id
      if (expectedId && currentId !== expectedId) {
        errors.push(
          `${spec.expectedId.errorPath}.${operation.name}.id 已变化（期望 ${expectedId}，实际 ${currentId ?? '无'}）`,
        )
        continue
      }
    }
    delete container![operation.name]
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, candidate }
}
