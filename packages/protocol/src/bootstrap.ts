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

export const BootstrapSchema = z
  .object({
    protocolVersion: z.literal(BOOTSTRAP_PROTOCOL_VERSION),
    instanceId: z.string().min(1),
    revision: z.string().min(1),
    preset: z.enum(['basic', 'full']),
    capabilities: z.array(BootstrapCapabilitySchema),
    protocolRanges: z
      .object({
        relay: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
        websocket: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
      })
      .strict(),
  })
  .strict()

export type BootstrapCapability = z.infer<typeof BootstrapCapabilitySchema>
export type Bootstrap = z.infer<typeof BootstrapSchema>

export function hasRequiredBootstrapCapabilities(bootstrap: Bootstrap): boolean {
  return BOOTSTRAP_REQUIRED_CAPABILITIES.every((capability) =>
    bootstrap.capabilities.includes(capability),
  )
}
