import { z } from 'zod'

const text = z.string().min(1)
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const version = z.literal(2)
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const IngressCapabilitySchema = z.enum([
  'tools',
  'hooks',
  'rpc.business',
  'rpc.management',
  'ingress',
  'manager.ui',
  'channel.identity',
])
export type IngressCapability = z.infer<typeof IngressCapabilitySchema>
export const IngressDependencySchema = z.object({ id, version: text }).strict()
export const IngressChannelGrantSchema = z.object({ channel: id, credentialKind: text }).strict()
export const IngressUiDescriptorSchema = z
  .object({ id, title: text, entry: text, apiPrefix: text, resourceVersion: text })
  .strict()
export const IngressApplySchema = z
  .object({
    state: z.enum(['applied', 'pending', 'failed', 'restart_required']),
    revision,
    reason: text.optional(),
  })
  .strict()
export const IngressStatusSchema = z
  .object({
    id,
    apiVersion: version,
    installed: z.boolean(),
    enabled: z.boolean(),
    savedVersion: text.nullable(),
    activeVersion: text.nullable(),
    state: z.enum(['inactive', 'starting', 'active', 'stopping', 'failed', 'stopped', 'unknown']),
    requiresRestart: z.boolean(),
    savedRevision: revision.nullable(),
    appliedRevision: revision.nullable(),
    apply: IngressApplySchema.shape.state,
    reason: text.optional(),
    grantedCapabilities: z.array(IngressCapabilitySchema),
    dependencies: z.array(IngressDependencySchema),
    backendUnavailable: z.boolean().optional(),
  })
  .strict()
export type IngressStatus = z.infer<typeof IngressStatusSchema>
export const IngressUiRegistrationSchema = z
  .object({
    pluginId: id,
    pluginVersion: text,
    apiVersion: version,
    descriptor: IngressUiDescriptorSchema,
    enabled: z.boolean(),
    businessState: IngressStatusSchema.shape.state,
    routes: z.array(
      z.object({ method: z.enum(['GET', 'POST', 'PUT', 'DELETE']), path: text }).strict(),
    ),
  })
  .strict()
export type IngressUiDescriptor = z.infer<typeof IngressUiDescriptorSchema>
export type IngressUiRegistration = z.infer<typeof IngressUiRegistrationSchema>
const configView = z
  .object({
    contractVersion: version,
    id,
    config: z.unknown(),
    baseRevision: revision,
    apply: IngressApplySchema,
  })
  .strict()
const mutation = z
  .object({
    contractVersion: version,
    requestId: text.max(256),
    registryRevision: revision,
    saved: z.literal(true),
    status: IngressStatusSchema,
  })
  .strict()
const mutate = z
  .object({
    contractVersion: version,
    id,
    expectedRegistryRevision: revision,
    requestId: text.max(256),
  })
  .strict()
const install = z
  .object({
    contractVersion: version,
    packagePath: text,
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expectedRegistryRevision: revision,
    requestId: text.max(256),
    grantedCapabilities: z.array(IngressCapabilitySchema),
    channelGrants: z.array(IngressChannelGrantSchema),
  })
  .strict()
export const IngressRequestSchemas = {
  'ingress.list': z.object({ contractVersion: version }).strict(),
  'ingress.install': install,
  'ingress.upgrade': install,
  'ingress.enable': mutate,
  'ingress.disable': mutate,
  'ingress.uninstall': mutate,
  'ingress.config.get': z.object({ contractVersion: version, id }).strict(),
  'ingress.config.save': z
    .object({
      contractVersion: version,
      id,
      config: z.unknown(),
      expectedBaseRevision: revision,
      requestId: text.max(256),
    })
    .strict(),
  'ingress.ui.list': z.object({ contractVersion: version, managerApiVersion: version }).strict(),
  'ingress.ui.read': z
    .object({
      contractVersion: version,
      pluginId: id,
      moduleId: id,
      resourceVersion: text,
      path: text,
    })
    .strict(),
  'ingress.management.call': z
    .object({
      contractVersion: version,
      moduleId: id,
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
      path: text,
      pathParams: z.record(z.string(), z.string()),
      query: z.record(z.string(), z.string()),
      body: z.unknown().optional(),
    })
    .strict(),
} as const
export const IngressResponseSchemas = {
  'ingress.list': z
    .object({
      contractVersion: version,
      hostApiVersion: version,
      registryRevision: revision,
      plugins: z.array(IngressStatusSchema),
      backendUnavailable: z.boolean().optional(),
      reason: text.optional(),
    })
    .strict(),
  'ingress.install': mutation,
  'ingress.upgrade': mutation,
  'ingress.enable': mutation,
  'ingress.disable': mutation,
  'ingress.uninstall': mutation,
  'ingress.config.get': configView,
  'ingress.config.save': configView.extend({ saved: z.literal(true) }),
  'ingress.ui.list': z
    .object({
      contractVersion: version,
      registryRevision: revision,
      modules: z.array(IngressUiRegistrationSchema),
    })
    .strict(),
  'ingress.ui.read': z
    .object({
      contractVersion: version,
      contentType: text,
      contentBase64: z.string(),
      resourceVersion: text,
    })
    .strict(),
  'ingress.management.call': z
    .object({
      contractVersion: version,
      status: z.number().int().min(200).max(599),
      body: z.union([
        z.object({ data: z.unknown() }).strict(),
        z.object({ error: z.object({ code: text, message: text }).strict() }).strict(),
      ]),
    })
    .strict(),
} as const
export type IngressMethodMap = {
  [M in keyof typeof IngressRequestSchemas]: {
    params: z.infer<(typeof IngressRequestSchemas)[M]>
    result: z.infer<(typeof IngressResponseSchemas)[M]>
  }
}
export type IngressListResult = IngressMethodMap['ingress.list']['result']
export const ManagerUiRegistrationSchema = IngressUiRegistrationSchema.extend({
  pagePath: text,
  assetPrefix: text,
  manager: z
    .object({
      apiVersion: version,
      resourceVersion: text.nullable(),
      state: z.enum(['ready', 'unavailable', 'version_mismatch']),
      reason: text.optional(),
    })
    .strict(),
})
export type ManagerUiRegistration = z.infer<typeof ManagerUiRegistrationSchema>
export const IngressHttpRequestSchemas = {
  install,
  upgrade: install,
  enable: mutate.omit({ id: true }),
  disable: mutate.omit({ id: true }),
  uninstall: mutate.omit({ id: true }),
  configSave: IngressRequestSchemas['ingress.config.save'].omit({ id: true }),
} as const
export const IngressHttpResponseSchemas = {
  list: z.object({ data: IngressResponseSchemas['ingress.list'] }).strict(),
  mutation: z.object({ data: mutation }).strict(),
  config: z.object({ data: configView }).strict(),
  configSave: z.object({ data: IngressResponseSchemas['ingress.config.save'] }).strict(),
  modules: z
    .object({
      data: z
        .object({
          contractVersion: version,
          managerApiVersion: version,
          registryRevision: revision,
          modules: z.array(ManagerUiRegistrationSchema),
        })
        .strict(),
    })
    .strict(),
} as const
