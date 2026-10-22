import { FILE_SERVICE_ADAPTER_CATALOG, buildFileServiceToolName, type FileCapabilityOperation } from '@chery/protocol'
import { captureRuntimeConfig } from '@/utils/config.js'
import { getChatType, getChatPreset } from '@/db/chat.js'
import { imageRevision } from '../config/impact.js'
import { resolveFileCapabilities, resolveFileCapability, type FileCapabilityRuntime, type ResolveFileCapabilityInput } from './capabilityResolver.js'
import { resolveBrainProtocol } from '@/core/llm/routing.js'
import { resolveEffectiveBrainCapabilities } from '@/utils/modelCatalog.js'
import { supportsNativeFile } from '@/core/message/fileSupport.js'
import { listRegisteredSenses, getSense } from '@/core/sense/senseRegistry.js'
import { getChatSpawnTypes } from '@/db/chat.js'
import { getSessionRoleRuntime, resolveChatRuntimeSelection } from '../chat/sessionRoleRuntime.js'
import { resolveFileServiceConnection } from '@/utils/fileServiceConnection.js'
import { readRuntimeEnvironment } from '@/utils/config.js'

export function fileCapabilityContext(chatId?: string, selection: Partial<ResolveFileCapabilityInput> = {}): ResolveFileCapabilityInput {
  const config = (selection.config ?? captureRuntimeConfig()) as ReturnType<typeof captureRuntimeConfig>
  const runtime: FileCapabilityRuntime = { brains: {}, services: {} }
  for (const [name, brain] of Object.entries(config.llm.brain)) {
    const protocol = resolveBrainProtocol(brain)
    const effective = resolveEffectiveBrainCapabilities({ model: brain.model, provider: brain.provider, protocol, userCapabilities: brain.capabilities })
    runtime.brains![name] = { toolCall: effective.toolCall.enabled, input: Object.fromEntries(Object.entries(effective.input).map(([kind, state]) => [kind, state.state])), nativeOperations: {
      'image.inspect': { availability: !supportsNativeFile(protocol, 'image/png') || effective.input.image.state === 'unsupported' ? 'unavailable' : effective.input.image.state === 'supported' ? 'available' : 'unknown', inputConstraints: { mimeTypes: effective.imageInput.formats, maxBytes: effective.imageInput.maxBytes }, outputKinds: ['text'] },
      'document.extract': { availability: !supportsNativeFile(protocol, 'application/pdf') || effective.input.pdf.state === 'unsupported' ? 'unavailable' : effective.input.pdf.state === 'supported' ? 'available' : 'unknown', inputConstraints: { mimeTypes: ['application/pdf', 'text/plain'] }, outputKinds: ['text'] },
    } }
  }
  for (const [id, service] of Object.entries(config.file_services ?? {})) {
    const adapter = FILE_SERVICE_ADAPTER_CATALOG.find(item => item.id === service.adapter)
    const configured = service.adapter === 'custom-sense-mcp'
      ? !!service.toolMapping && !!getSense(service.toolMapping.toolName)
      : resolveFileServiceConnection(service, config.llm.brain, readRuntimeEnvironment()).errors.length === 0
    runtime.services![id] = Object.fromEntries(service.operations.map(operation => [operation, {
      availability: service.enabled === false ? 'unavailable' : adapter?.supportedOperations.includes(operation) && configured ? 'available' : 'unknown', outputKinds: ['image.inspect', 'document.extract', 'audio.transcribe', 'video.inspect'].includes(operation) ? ['text'] : ['image'],
    }]))
  }
  const generated = new Set(Object.entries(config.file_services ?? {}).flatMap(([id, service]) => service.operations.map(operation => buildFileServiceToolName(id, operation))))
  runtime.tools = listRegisteredSenses().filter(({ name, sense, origin }) => !generated.has(name) && sense.capabilities?.mappings?.length && origin?.available?.() !== false).map(({ name, sense }) => ({
    name,
    operations: Object.fromEntries((sense.capabilities?.operations ?? []).filter(operation => sense.capabilities!.mappings!.some(mapping => mapping.operation === operation && mapping.inputAssetField && mapping.questionField && mapping.transferMode && mapping.transferMode !== 'local-path')).map(operation => [operation, { availability: 'available' }])),
  }))
  if (chatId) {
    const roleName = selection.roleName ?? getChatType(chatId)
    const presetName = selection.preset ?? getChatPreset(chatId)
    const preset = presetName ? config.presets?.[presetName] : undefined
    const reserved = new Set(Object.values(config.presets ?? {}).map(item => item.detailRole).filter(Boolean))
    const members = Object.entries(config.roles ?? {}).filter(([name, role]) => role.kind !== 'shadow' && !reserved.has(name)).map(([name]) => name)
    runtime.dispatchRoster = {}
    runtime.roleSelections = {}
    for (const name of members) {
      // Root roster is locked at chat creation; a newly dispatched child uses the ordinary-role roster.
      runtime.dispatchRoster[name] = (name === roleName ? getChatSpawnTypes(chatId) ?? preset?.roles ?? members : members).filter(target => target !== name && members.includes(target))
      runtime.roleSelections[name] = getSessionRoleRuntime(chatId, name)
    }
  }
  return { config, configRevision: imageRevision(config), roleName: chatId ? getChatType(chatId) : undefined,
    preset: chatId ? getChatPreset(chatId) : undefined, runtimeSelection: chatId ? resolveChatRuntimeSelection(chatId) ?? undefined : undefined, runtime, operation: 'image.inspect', ...selection }
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
