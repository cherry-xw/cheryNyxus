import { z } from 'zod'

/** The protected, small startup contract returned with the authenticated config. */
export const BOOTSTRAP_PROTOCOL_VERSION = 1 as const

export const BOOTSTRAP_REQUIRED_CAPABILITIES = [
  'chat.core',
  'interaction.respond',
  'timeline.read',
] as const

export const BOOTSTRAP_OPTIONAL_CAPABILITIES = [
  'timeline.graph',
  'task.overview',
  'workspace.files',
  'terminal.session',
  'settings.manage',
  'media.attach',
] as const

export const BootstrapCapabilitySchema = z.enum([
  ...BOOTSTRAP_REQUIRED_CAPABILITIES,
  ...BOOTSTRAP_OPTIONAL_CAPABILITIES,
])

export const SoftwareDiagnosticSchema = z.object({ version: z.string().min(1).max(128), buildId: z.string().min(1).max(128).optional() }).strict()
export const BusinessSelectionSchema = z.object({ bootstrapVersion: z.literal(1), protocolVersion: z.literal(1), instanceId: z.string().min(1).max(128), capabilityRevision: z.string().min(1).max(128) }).strict()

export const BootstrapSchema = z
  .object({
    protocolVersion: z.literal(BOOTSTRAP_PROTOCOL_VERSION),
    instanceId: z.string().min(1).max(128),
    revision: z.string().min(1).max(128),
    preset: z.enum(['basic', 'full']),
    software: z.object({ backend: SoftwareDiagnosticSchema.optional(), relay: SoftwareDiagnosticSchema.optional() }).strict().optional(),
    capabilities: z.array(z.string().min(1).max(128)).max(128)
      .refine((values) => new Set(values).size === values.length, 'Duplicate capability')
      .refine((values) => BOOTSTRAP_REQUIRED_CAPABILITIES.every((c) => values.includes(c)), 'Required capability missing')
      .transform((values) => values.filter((v): v is z.infer<typeof BootstrapCapabilitySchema> => BootstrapCapabilitySchema.safeParse(v).success)),
    protocolRanges: z
      .object({
        bootstrap: z.object({ min: z.number().int().positive().max(65535), max: z.number().int().positive().max(65535) }).strict().optional(),
        relay: z.object({ min: z.number().int().positive().max(65535), max: z.number().int().positive().max(65535) }).strict(),
        websocket: z.object({ min: z.number().int().positive().max(65535), max: z.number().int().positive().max(65535) }).strict(),
      })
      .strict(),
  })
  .strict()
  .refine((value) => Object.values(value.protocolRanges).every((range) => !range || range.min <= range.max), 'Invalid protocol range')

export function selectBusinessProtocols(bootstrap: Bootstrap) {
  const select = (range: { min: number; max: number }, domain: string) => {
    const min = Math.max(1, range.min), max = Math.min(1, range.max)
    if (min > max) throw new Error(`${domain}协议没有可用交集，请更新服务`)
    return max
  }
  return BusinessSelectionSchema.parse({ bootstrapVersion: select(bootstrap.protocolRanges.bootstrap ?? { min: bootstrap.protocolVersion, max: bootstrap.protocolVersion }, 'bootstrap'), protocolVersion: select(bootstrap.protocolRanges.websocket, '业务WebSocket'), instanceId: bootstrap.instanceId, capabilityRevision: bootstrap.revision })
}
export function readBusinessSelection(url: URL) {
  const keys = ['bootstrapVersion', 'protocolVersion', 'instanceId', 'capabilityRevision'] as const
  if (keys.some((key) => url.searchParams.getAll(key).length !== 1)) throw new Error('Business selection required')
  return BusinessSelectionSchema.parse({ bootstrapVersion: Number(url.searchParams.get('bootstrapVersion')), protocolVersion: Number(url.searchParams.get('protocolVersion')), instanceId: url.searchParams.get('instanceId'), capabilityRevision: url.searchParams.get('capabilityRevision') })
}
export function assertBusinessSelection(url: URL, bootstrap: Bootstrap): void {
  const selected = readBusinessSelection(url), expected = selectBusinessProtocols(bootstrap)
  if (JSON.stringify(selected) !== JSON.stringify(expected)) throw new Error('Business selection changed')
}

export type BootstrapCapability = z.infer<typeof BootstrapCapabilitySchema>
export type Bootstrap = z.infer<typeof BootstrapSchema>

export function hasRequiredBootstrapCapabilities(bootstrap: Bootstrap): boolean {
  return BOOTSTRAP_REQUIRED_CAPABILITIES.every((capability) =>
    bootstrap.capabilities.includes(capability),
  )
}
