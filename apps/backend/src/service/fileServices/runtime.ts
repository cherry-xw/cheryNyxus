import { FILE_SERVICE_ADAPTER_CATALOG, buildFileServiceToolName, type FileCapabilityOperation } from '@chery/protocol'
import { captureRuntimeConfig } from '@/utils/config.js'
import { getChatType, getChatPreset, getChatRuntimeSelection } from '@/db/chat.js'
import { imageRevision } from '../config/impact.js'
import { resolveFileCapabilities, resolveFileCapability, type FileCapabilityRuntime, type ResolveFileCapabilityInput } from './capabilityResolver.js'
import { resolveBrainProtocol } from '@/core/llm/routing.js'
import { resolveEffectiveBrainCapabilities } from '@/utils/modelCatalog.js'
import { supportsNativeFile } from '@/core/message/fileSupport.js'
import { listRegisteredSenses, getSense } from '@/core/sense/senseRegistry.js'

export function fileCapabilityContext(chatId?: string, selection: Partial<ResolveFileCapabilityInput> = {}): ResolveFileCapabilityInput {
  const config = (selection.config ?? captureRuntimeConfig()) as ReturnType<typeof captureRuntimeConfig>
  const runtime: FileCapabilityRuntime = { brains: {}, services: {} }
  for (const [name, brain] of Object.entries(config.llm.brain)) {
    const protocol = resolveBrainProtocol(brain)
    const effective = resolveEffectiveBrainCapabilities({ model: brain.model, provider: brain.provider, protocol, userCapabilities: brain.capabilities })
    runtime.brains![name] = { toolCall: effective.toolCall.enabled, input: Object.fromEntries(Object.entries(effective.input).map(([kind, state]) => [kind, state.state])), nativeOperations: {
      'image.inspect': { availability: supportsNativeFile(protocol, 'image/png') && effective.input.image.state === 'supported' ? 'available' : 'unknown', inputConstraints: { mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] }, outputKinds: ['text'] },
      'document.extract': { availability: supportsNativeFile(protocol, 'application/pdf') && effective.input.pdf.state === 'supported' ? 'available' : 'unknown', inputConstraints: { mimeTypes: ['application/pdf', 'text/plain'] }, outputKinds: ['text'] },
    } }
  }
  for (const [id, service] of Object.entries(config.file_services ?? {})) {
    const adapter = FILE_SERVICE_ADAPTER_CATALOG.find(item => item.id === service.adapter)
    const brain = service.connection.brainRef ? config.llm.brain[service.connection.brainRef] : undefined
    const configured = service.adapter === 'custom-sense-mcp'
      ? !!service.toolMapping && !!getSense(service.toolMapping.toolName)
      : !!(brain?.url ?? service.connection.baseUrl) && !!(service.connection.model ?? brain?.model)
    runtime.services![id] = Object.fromEntries(service.operations.map(operation => [operation, {
      availability: service.enabled === false ? 'unavailable' : adapter?.supportedOperations.includes(operation) && configured ? 'available' : 'unknown', outputKinds: ['image.inspect', 'document.extract', 'audio.transcribe', 'video.inspect'].includes(operation) ? ['text'] : ['image'],
    }]))
  }
  const generated = new Set(Object.entries(config.file_services ?? {}).flatMap(([id, service]) => service.operations.map(operation => buildFileServiceToolName(id, operation))))
  runtime.tools = listRegisteredSenses().filter(({ name, sense, origin }) => !generated.has(name) && sense.capabilities?.mappings?.length && origin?.available?.() !== false).map(({ name, sense }) => ({
    name,
    operations: Object.fromEntries((sense.capabilities?.operations ?? []).filter(operation => sense.capabilities!.mappings!.some(mapping => mapping.operation === operation && mapping.inputAssetField && mapping.questionField && mapping.transferMode && mapping.transferMode !== 'local-path')).map(operation => [operation, { availability: 'available' }])),
  }))
  return { config, configRevision: imageRevision(config), roleName: chatId ? getChatType(chatId) : undefined,
    preset: chatId ? getChatPreset(chatId) : undefined, runtimeSelection: chatId ? getChatRuntimeSelection(chatId) ?? undefined : undefined, runtime, operation: 'image.inspect', ...selection }
}
export function resolveChatFileCapabilities(chatId?: string, selection: Partial<ResolveFileCapabilityInput> = {}) {
  const { explicit, ...context } = fileCapabilityContext(chatId, selection)
  return resolveFileCapabilities({ ...context, ...(explicit ? { explicit: { [context.operation]: explicit } } : {}) })
}
export function resolveChatFileCapability(chatId: string, operation: FileCapabilityOperation) {
  return resolveFileCapability({ ...fileCapabilityContext(chatId), operation })
}
export function assertFileServiceRoleAllowed(chatId: string, serviceId: string, operation: FileCapabilityOperation): void {
  const resolved = resolveFileCapability({ ...fileCapabilityContext(chatId), operation, explicit: { mode: 'tool', targetId: buildFileServiceToolName(serviceId, operation) } })
  if (!['available', 'requires_approval'].includes(resolved.availability)) throw new Error(resolved.reason)
}
