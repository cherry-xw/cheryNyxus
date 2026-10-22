import { z } from 'zod'
import { ImageOutputCapabilitiesSchema, IMAGE_COUNT_PARAM_KEYS } from './imageGeneration.js'
import { ConfigApplyStateSchema, ConfigSaveResultSchema } from './configApply.js'
import {
  CAPABILITY_STATES,
  FILE_CAPABILITY_OPERATIONS,
  FILE_SERVICE_ADAPTER_IDS,
  LLM_PROTOCOLS,
} from './llm.js'

/** Settings management data. Keys are accepted on writes, never on resource reads. */
export const SettingsNameSchema = z.string().min(1).max(128).refine(
  value => !!value.trim() && !/[\u0000-\u001f]/.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value),
)
export const SettingsResourceKindSchema = z.enum(['brains', 'sense-groups', 'presets'])
const revision = z.string().min(1)
const requestId = z.string().min(1).max(128)
const protocol = z.enum(LLM_PROTOCOLS)
export const SettingsCapabilityValueSchema = z.union([z.enum(CAPABILITY_STATES), z.boolean()])
export const SettingsInputMediaCapabilitiesSchema = z.object({
  image: SettingsCapabilityValueSchema.optional(),
  video: SettingsCapabilityValueSchema.optional(),
  audio: SettingsCapabilityValueSchema.optional(),
  pdf: SettingsCapabilityValueSchema.optional(),
}).strict()
export const SettingsOutputMediaCapabilitiesSchema = z.object({
  image: SettingsCapabilityValueSchema.optional(),
  video: SettingsCapabilityValueSchema.optional(),
  audio: SettingsCapabilityValueSchema.optional(),
}).strict()
export const SettingsBrainCapabilitiesSchema = z.object({
  imageOutput: ImageOutputCapabilitiesSchema.optional(),
  imageInput: z.object({
    formats: z.array(z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])).refine(v => new Set(v).size === v.length).optional(),
    animation: z.enum(['supported', 'first-frame', 'unsupported', 'unknown']).optional(),
    maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxBase64Bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict().optional(),
  toolCall: z.boolean().optional(),
  input: SettingsInputMediaCapabilitiesSchema.optional(),
  output: SettingsOutputMediaCapabilitiesSchema.optional(),
}).strict()
export const SettingsFileCapabilityBindingSchema = z.object({
  mode: z.enum(['auto', 'native', 'tool', 'role', 'disabled']),
  targetId: z.string().min(1).optional(),
  fallback: z.literal('none').optional(),
}).strict()
export const SettingsRoleFileCapabilitiesSchema = z.partialRecord(
  z.enum(FILE_CAPABILITY_OPERATIONS),
  SettingsFileCapabilityBindingSchema,
)
export const SettingsFileServiceConnectionSchema = z.object({
  capabilities: z.object({ imageOutput: ImageOutputCapabilitiesSchema.optional() }).strict().optional(),
  brainRef: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  keyRef: z.string().optional(),
  authType: z.enum(['bearer', 'x-api-key', 'query-key', 'none']).optional(),
  endpointOverrides: z.partialRecord(z.enum(FILE_CAPABILITY_OPERATIONS), z.string().min(1)).optional(),
}).strict()
export const SettingsFileServiceSchema = z.object({
  toolMapping: z.object({ toolName: z.string().min(1), inputAssetField: z.string().min(1), questionField: z.string().min(1), transferMode: z.enum(['base64', 'data-url', 'asset-id']), constantParams: z.record(z.string(), z.unknown()).optional(), resultPath: z.string().optional() }).strict().optional(),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  adapter: z.enum(FILE_SERVICE_ADAPTER_IDS),
  connection: SettingsFileServiceConnectionSchema,
  operations: z.array(z.enum(FILE_CAPABILITY_OPERATIONS)).min(1),
  defaults: z.record(z.string(), z.unknown()).refine(value => !IMAGE_COUNT_PARAM_KEYS.some(key => Object.hasOwn(value, key)), '服务默认参数不保存张数；请使用全局默认或本次张数').optional(),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  queueTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
  maxConcurrent: z.number().int().positive().optional(),
}).strict()
export const SettingsFilesPolicySchema = z.object({
  imageGeneration: z.object({ defaultCount: z.number().int().positive().safe().optional() }).strict().optional(),
  maxUploadBytes: z.number().int().positive().optional(),
  imageContext: z.object({
    mode: z.enum(['current', 'recent', 'unlimited']).optional(),
    recentUserTurns: z.number().int().min(1).max(10000).optional(),
    replacement: z.enum(['description', 'keywords']).optional(),
    missingDescription: z.enum(['existing', 'inspect']).optional(),
    serviceId: z.string().min(1).optional(),
    maxDescriptionChars: z.number().int().min(100).max(4000).optional(),
    maxTotalDescriptionChars: z.number().int().min(100).max(40000).optional(),
  }).strict().optional(),
  context: z.object({
    recentUserTurns: z.number().int().nonnegative().optional(),
    maxAssets: z.number().int().positive().optional(),
    maxBinaryBytes: z.number().int().positive().optional(),
    maxExtractedCharsPerAsset: z.number().int().positive().optional(),
    maxExtractedChars: z.number().int().positive().optional(),
    defaultImageVariant: z.enum(['original', 'adapted']).optional(),
  }).strict().optional(),
  imageAdaptation: z.object({
    maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxEdge: z.number().int().positive().max(16384).optional(),
    quality: z.number().int().min(1).max(100).optional(),
  }).strict().optional(),
  unreferencedUploadRetentionHours: z.number().int().positive().optional(),
  unreferencedAssetRetentionHours: z.number().int().positive().optional(),
}).strict()
export const SettingsBrainSchema = z.object({
  url: z.string().optional(), model: z.string().refine(v => !!v.trim()),
  provider: z.string().refine(v => !!v.trim()), protocol: protocol.optional(),
  key: z.string().optional(), thinking: z.string().min(1).optional(),
  rpm: z.number().positive().optional(), fullUrl: z.boolean().optional(),
  mock: z.object({ enabled: z.boolean().optional(), file: z.string(), chunkDelayMs: z.number().optional(), preRespondMs: z.number().optional() }).strict().optional(),
  contextLimit: z.number().positive().optional(), capabilities: SettingsBrainCapabilitiesSchema.optional(),
  hooks: z.string().optional(), anthropicCompat: z.object({ official: z.boolean().optional() }).strict().optional(),
}).strict()
export const SettingsBrainViewSchema = SettingsBrainSchema.omit({ key: true })
export const SettingsSenseGroupSchema = z.array(z.string().refine(v => !!v.trim()))
export const SettingsPresetSchema = z.object({
  id: z.string().optional(), shadows: z.object({ conversationRouting: z.string().optional() }).strict().optional(),
  detailRole: z.string().optional(), leader: z.string().optional(), roles: z.array(z.string()).optional(),
  roleOverrides: z.record(z.string(), z.object({ fileCapabilities: SettingsRoleFileCapabilitiesSchema.optional() }).strict()).optional(),
  workspace: z.string().optional(), schedule: z.object({ cron: z.string(), task: z.string(), enabled: z.boolean().optional() }).strict().optional(),
  rule: z.string().optional(), brain: z.string().optional(), senseGroup: z.string().optional(),
}).strict()
export const SettingsToolSchema = z.object({
  name: z.string(), label: z.string(), description: z.string(), icon: z.string(),
  source: z.enum(['builtin', 'custom', 'mcp', 'plugin']).optional(),
  pluginId: z.string().optional(), pluginVersion: z.string().optional(), unavailableReason: z.string().optional(),
  operations: z.array(z.enum(FILE_CAPABILITY_OPERATIONS)).optional(),
  accepts: z.array(z.string()).optional(),
}).strict()
export const SettingsCatalogSchema = z.object({
  brains: z.array(z.string()), senseGroups: z.array(z.string()), presets: z.array(z.string()),
  tools: z.array(SettingsToolSchema), baseRevision: revision,
}).strict()
const view = { name: SettingsNameSchema, baseRevision: revision, apply: ConfigApplyStateSchema }
const brainView = z.object({ ...view, kind: z.literal('brains'), value: SettingsBrainViewSchema,
  secrets: z.object({ keyConfigured: z.boolean() }).strict() }).strict()
const groupView = z.object({ ...view, kind: z.literal('sense-groups'), value: SettingsSenseGroupSchema }).strict()
const presetView = z.object({ ...view, kind: z.literal('presets'), value: SettingsPresetSchema }).strict()
export const SettingsResourceViewSchema = z.discriminatedUnion('kind', [brainView, groupView, presetView])
const saved = { saved: z.literal(true), save: ConfigSaveResultSchema }
export const SettingsSaveResourceResultSchema = z.discriminatedUnion('kind', [
  brainView.extend(saved), groupView.extend(saved), presetView.extend(saved),
])
const saveBody = { name: SettingsNameSchema, originalName: SettingsNameSchema.optional(), expectedBaseRevision: revision, requestId }
export const SettingsSaveResourceBodySchema = z.object({ ...saveBody,
  value: z.union([SettingsBrainSchema.partial(), SettingsSenseGroupSchema, SettingsPresetSchema]),
}).strict()
export const SettingsDeleteResourceBodySchema = z.object({ name: SettingsNameSchema, expectedBaseRevision: revision, requestId }).strict()
export const SettingsDeleteResourceResultSchema = z.object({ deleted: z.literal(true), name: SettingsNameSchema, baseRevision: revision }).strict()
export const SettingsModelsBodySchema = z.object({
  provider: z.string().min(1).max(64).refine(v => !!v.trim()), url: z.string().max(2048),
  key: z.string().max(8192).optional(), savedBrain: SettingsNameSchema.optional(),
  protocol: protocol.optional(), fullUrl: z.boolean().optional(),
}).strict()
export const SettingsModelsResultSchema = z.object({ models: z.array(z.object({ id: z.string(), name: z.string().optional(), ownedBy: z.string().optional() }).strict()) }).strict()
export const SettingsModelRecommendationBodySchema = z.object({
  model: z.string().min(1).max(512).refine(v => !!v.trim()), provider: z.string().optional(), protocol: protocol.optional(),
}).strict()
const recommendation = z.object({ provider: z.string().optional(), protocol: protocol.optional(),
  contextLimit: z.number().positive().optional(), thinking: z.string().min(1).optional(), capabilities: SettingsBrainCapabilitiesSchema.optional() }).strict()
export const SettingsModelRecommendationResultSchema = z.object({
  matched: z.boolean(), id: z.string().optional(), confidence: z.enum(['exact', 'pattern', 'unknown']),
  facts: z.object({ contextWindow: z.number().positive().optional(), protocols: z.array(protocol).optional(), capabilities: SettingsBrainCapabilitiesSchema.optional() }).strict().optional(),
  recommend: recommendation.optional(), thinkingLevels: z.array(z.string().min(1)),
  unknown: z.object({ recommend: recommendation.optional(), capabilities: SettingsBrainCapabilitiesSchema.optional() }).strict(),
}).strict()
export const SettingsPromptsSaveBodySchema = z.object({
  preset: SettingsNameSchema, scope: z.enum(['global', 'role']), content: z.string().max(100000),
  expectedContentRevision: revision, expectedBaseRevision: revision,
}).strict()
export const SettingsPromptsViewSchema = z.object({
  preset: SettingsNameSchema, baseRevision: revision,
  contentRevisions: z.object({ global: revision, role: revision }).strict(),
  global: z.string(), role: z.string(), sharedPresets: z.array(z.string()), roleConfigured: z.boolean(),
}).strict()
export const SettingsPromptsSaveResultSchema = SettingsPromptsViewSchema.extend({ saved: z.literal(true), runtimeRefreshRequired: z.literal(true) })
export const SettingsSearchConfigSchema = z.object({
  providers: z.array(z.enum(['anysearch', 'parallel', 'exa', 'browser'])).min(1).max(4).refine(v => new Set(v).size === v.length),
  proxyEnabled: z.boolean(), proxyUrl: z.string().max(2048).refine(v => {
    if (!v) return true
    try { const u = new URL(v); return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash } catch { return false }
  }),
}).strict().refine(v => !v.proxyEnabled || !!v.proxyUrl)
export const SettingsSearchViewSchema = z.object({ settings: SettingsSearchConfigSchema, revision }).strict()
export const SettingsSearchSaveBodySchema = z.object({ settings: SettingsSearchConfigSchema, expectedRevision: revision }).strict()
export const SettingsSearchSaveResultSchema = SettingsSearchViewSchema.extend({ saved: z.literal(true) })
const empty = z.object({}).strict()
const resourcePath = z.object({ kind: SettingsResourceKindSchema }).strict()
const route = <B extends z.ZodType>(body: B) => z.object({ pathParams: empty, query: empty, body }).strict()
export const SettingsRequestSchemas = {
  catalog: z.object({ pathParams: empty, query: empty }).strict(),
  apply: z.object({ pathParams: empty, query: empty }).strict(),
  resourceGet: z.object({ pathParams: resourcePath, query: z.object({ name: SettingsNameSchema }).strict() }).strict(),
  resourceSave: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('brains'), value: SettingsBrainSchema.partial() }).strict(),
    z.object({ kind: z.literal('sense-groups'), value: SettingsSenseGroupSchema }).strict(),
    z.object({ kind: z.literal('presets'), value: SettingsPresetSchema }).strict(),
  ]),
  resourceDelete: z.object({ pathParams: resourcePath, query: empty, body: SettingsDeleteResourceBodySchema }).strict(),
  models: route(SettingsModelsBodySchema), modelRecommendation: route(SettingsModelRecommendationBodySchema),
  promptsGet: z.object({ pathParams: empty, query: z.object({ preset: SettingsNameSchema }).strict() }).strict(),
  promptsSave: route(SettingsPromptsSaveBodySchema),
  searchGet: z.object({ pathParams: empty, query: empty }).strict(), searchSave: route(SettingsSearchSaveBodySchema),
}
/** Check the resource kind together with the value, rather than accepting a mismatched union. */
export const SettingsResourceSaveRequestSchema = z.object({
  pathParams: resourcePath, query: empty, body: SettingsSaveResourceBodySchema,
}).strict().superRefine((v, ctx) => {
  const result = SettingsRequestSchemas.resourceSave.safeParse({ kind: v.pathParams.kind, value: v.body.value })
  if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: ['body', ...issue.path] })
})
export const SettingsResponseSchemas = {
  catalog: SettingsCatalogSchema, apply: ConfigApplyStateSchema,
  resourceGet: SettingsResourceViewSchema, resourceSave: SettingsSaveResourceResultSchema,
  resourceDelete: SettingsDeleteResourceResultSchema, models: SettingsModelsResultSchema,
  modelRecommendation: SettingsModelRecommendationResultSchema,
  promptsGet: SettingsPromptsViewSchema, promptsSave: SettingsPromptsSaveResultSchema,
  searchGet: SettingsSearchViewSchema, searchSave: SettingsSearchSaveResultSchema,
}
export type SettingsResourceKind = z.infer<typeof SettingsResourceKindSchema>
export type SettingsCatalog = z.infer<typeof SettingsCatalogSchema>
export type SettingsPresetValue = z.infer<typeof SettingsPresetSchema>
export type SettingsResourceView = z.infer<typeof SettingsResourceViewSchema>
export type SettingsSaveResourceResult = z.infer<typeof SettingsSaveResourceResultSchema>
