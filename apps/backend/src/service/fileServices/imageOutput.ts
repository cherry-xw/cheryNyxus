import {
  calculateImageCount, requestedImageCount, withoutImageCountParams,
  FILE_SERVICE_ADAPTER_CATALOG,
  mergeImageParameters,
  type ImageOutputCapability, type ImageOutputOperation, type ImageCountPlan,
} from '@chery/protocol'
import type { FileServiceConfig } from '@chery/plugin-api'
import { resolveModelCatalog, isCapabilitySupported } from '@/utils/modelCatalog.js'
import { captureRuntimeConfig } from '@/utils/config.js'
import { imageRevision } from '../config/impact.js'
import { resolveFileServiceConnection } from '@/utils/fileServiceConnection.js'
import { readRuntimeEnvironment } from '@/utils/config.js'

export interface ResolvedImageOutput {
  model: string
  imageModel: string
  adapter: string
  operation: ImageOutputOperation
  configRevision: string
  capability: ImageOutputCapability
  source: 'user' | 'catalog' | 'adapter' | 'default'
  count: ImageCountPlan
  availability: 'available' | 'unknown' | 'unavailable'
  reason?: string
}

/** 不查远端。目录不能把某协议的张数参数移植到另一个协议。 */
export function resolveImageOutput(input: {
  service: FileServiceConfig; operation: ImageOutputOperation; desiredCount?: number
  params?: Record<string, unknown>; inputImages?: number
  config?: ReturnType<typeof captureRuntimeConfig>
}): ResolvedImageOutput {
  const config = input.config ?? captureRuntimeConfig()
  const { service, operation } = input
  const brain = service.connection.brainRef ? config.llm.brain[service.connection.brainRef] : undefined
  const model = service.connection.model ?? brain?.model ?? ''
  const params = mergeImageParameters(service.defaults, input.params)
  const imageModel = service.adapter === 'openai-responses-image' ? String(params.image_model ?? 'gpt-image-1') : model
  const catalog = resolveModelCatalog({ model: imageModel, provider: brain?.provider })
  // Responses 的连接大脑是对话模型，不能把它的原生限制当成图片工具型号限制。
  const configured = service.connection.capabilities?.imageOutput?.[operation] ?? (service.adapter === 'openai-responses-image' ? undefined : brain?.capabilities?.imageOutput?.[operation])
  const manual = configured && (!configured.adapter || configured.adapter === service.adapter) ? configured : undefined
  const candidate = catalog.recommend?.capabilities?.imageOutput?.[operation] ?? catalog.facts?.capabilities?.imageOutput?.[operation]
  const described = candidate?.adapter === service.adapter ? candidate : undefined
  let capability: ImageOutputCapability = manual ?? described ?? { nativeMultiImage: 'unknown', countControl: 'unknown' }
  let source: ResolvedImageOutput['source'] = manual ? 'user' : described ? 'catalog' : 'default'
  if (['openai-responses-image', 'google-gemini-image'].includes(service.adapter)) {
    capability = { nativeMultiImage: 'unknown', countControl: 'uncontrolled' }
    source = 'adapter'
  } else {
    // 这是实现边界，不是未知型号的多图能力证明。
    const interfaceMaximum = service.adapter === 'openai-images' ? 10 : service.adapter === 'minimax-images' ? 9
      : service.adapter === 'doubao-seedream' ? 15 : service.adapter === 'google-imagen' ? 4 : undefined
    if (interfaceMaximum === undefined) { capability = { nativeMultiImage: 'unknown', countControl: 'unknown' }; source = 'adapter' }
    else if (capability.maxImagesPerRequest !== undefined) capability = { ...capability, maxImagesPerRequest: Math.min(capability.maxImagesPerRequest, interfaceMaximum) }
    if (['requested', 'maximum'].includes(capability.countControl)) capability = { ...capability,
      countControl: service.adapter === 'doubao-seedream' ? 'maximum' : 'requested' }
    if (service.adapter === 'doubao-seedream' && /^doubao-seedream-5-0-(pro|flash)(?:-|$)/.test(model)) {
      capability = { nativeMultiImage: 'unsupported', countControl: 'requested', maxImagesPerRequest: 1 }; source = 'adapter'
    }
  }
  const desiredCount = requestedImageCount(input.params ?? {}, input.desiredCount) ?? config.files?.imageGeneration?.defaultCount ?? 1
  const adapter = FILE_SERVICE_ADAPTER_CATALOG.find(item => item.id === service.adapter)
  const knownModel = isCapabilitySupported(catalog.facts?.capabilities?.output?.image) || isCapabilitySupported(catalog.recommend?.capabilities?.output?.image) ||
    manual?.nativeMultiImage !== undefined && manual.nativeMultiImage !== 'unknown' || service.adapter === 'openai-responses-image' ||
    service.adapter === 'custom-sense-mcp' && !!service.toolMapping || adapter?.representativeModels?.includes(model) === true
  const connectionErrors = resolveFileServiceConnection(service, config.llm.brain, readRuntimeEnvironment()).errors
  const availability = !adapter?.supportedOperations.includes(operation) || service.enabled === false ? 'unavailable'
    : service.adapter !== 'custom-sense-mcp' && connectionErrors.length > 0 || !knownModel ? 'unknown' : 'available'
  return { model, imageModel, adapter: service.adapter, operation, capability, source,
    availability, ...(availability === 'available' ? {} : { reason: availability === 'unavailable' ? '适配器不支持此操作或服务已停用' : connectionErrors.join('\n') || '此型号或接入点的绘图能力尚未确认，请核对型号及模型能力配置' }),
    configRevision: imageRevision({ service, brain, capability, imageModel }),
    count: calculateImageCount(desiredCount, capability, input.inputImages) }
}

export function imageCountParams(service: FileServiceConfig, resolution: ResolvedImageOutput, params: Record<string, unknown>): Record<string, unknown> {
  if (resolution.availability !== 'available') throw new Error(resolution.reason)
  const result = withoutImageCountParams(params)
  if (resolution.capability.nativeMultiImage === 'unsupported') return result
  const count = resolution.count.effectiveCount
  if (count === undefined) {
    if (requestedImageCount(params) !== undefined) throw new Error('此型号与接口没有已确认的张数控制；不能发送厂商数量参数')
    return result
  }
  if (service.adapter === 'openai-images' || service.adapter === 'minimax-images') result.n = count
  else if (service.adapter === 'google-imagen') result.sampleCount = count
  else if (service.adapter === 'doubao-seedream' && resolution.capability.nativeMultiImage === 'supported') {
    result.sequential_image_generation = count === 1 ? 'disabled' : 'auto'
    if (count > 1) result.sequential_image_generation_options = { max_images: count }
  }
  return result
}
