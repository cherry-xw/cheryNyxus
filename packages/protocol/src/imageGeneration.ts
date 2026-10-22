import { z } from 'zod'

export const IMAGE_OUTPUT_OPERATIONS = ['image.generate', 'image.reference', 'image.edit'] as const
export type ImageOutputOperation = typeof IMAGE_OUTPUT_OPERATIONS[number]
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const ImageOutputCapabilitySchema = z.object({
  adapter: z.string().min(1).optional(),
  nativeMultiImage: z.enum(['supported', 'unsupported', 'unknown']),
  countControl: z.enum(['requested', 'maximum', 'uncontrolled', 'unknown']),
  maxImagesPerRequest: count.optional(),
  maxInputAndOutputImages: count.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.nativeMultiImage === 'unsupported' && value.maxImagesPerRequest !== undefined && value.maxImagesPerRequest !== 1)
    ctx.addIssue({ code: 'custom', path: ['maxImagesPerRequest'], message: '单图能力的上限只能是 1' })
  if (value.nativeMultiImage === 'supported' && (value.maxImagesPerRequest === undefined || value.maxImagesPerRequest < 2))
    ctx.addIssue({ code: 'custom', path: ['maxImagesPerRequest'], message: '支持原生多图时请填写至少为 2 的上限' })
  if (['requested', 'maximum'].includes(value.countControl) && value.maxImagesPerRequest === undefined)
    ctx.addIssue({ code: 'custom', path: ['maxImagesPerRequest'], message: '可控制张数时必须填写上限' })
})
export const ImageOutputCapabilitiesSchema = z.partialRecord(z.enum(IMAGE_OUTPUT_OPERATIONS), ImageOutputCapabilitySchema)
export type ImageOutputCapability = z.infer<typeof ImageOutputCapabilitySchema>
export type ImageOutputCapabilities = z.infer<typeof ImageOutputCapabilitiesSchema>
export type ImageCountControl = ImageOutputCapability['countControl']

export interface ImageCountPlan {
  desiredCount: number
  effectiveCount?: number
  effectiveMaximum?: number
  countControl: ImageCountControl
  nativeMultiImage: ImageOutputCapability['nativeMultiImage']
  reason?: string
}
export const ImageCountPlanSchema = z.object({
  desiredCount: count, effectiveCount: count.optional(), effectiveMaximum: count.optional(),
  countControl: z.enum(['requested', 'maximum', 'uncontrolled', 'unknown']),
  nativeMultiImage: z.enum(['supported', 'unsupported', 'unknown']), reason: z.string().optional(),
}).strict()

export function isImageOutputOperation(operation: string): operation is ImageOutputOperation {
  return (IMAGE_OUTPUT_OPERATIONS as readonly string[]).includes(operation)
}

/** 只计算，不修改原期望值，也不发起任何生成。 */
export function calculateImageCount(desiredCount: number, capability: ImageOutputCapability, inputImages = 0): ImageCountPlan {
  count.parse(desiredCount)
  z.number().int().nonnegative().safe().parse(inputImages)
  const plan: ImageCountPlan = { desiredCount, countControl: capability.countControl, nativeMultiImage: capability.nativeMultiImage }
  let maximum = capability.nativeMultiImage === 'unsupported' ? 1 : capability.maxImagesPerRequest
  if (capability.maxInputAndOutputImages !== undefined) {
    const remaining = capability.maxInputAndOutputImages - inputImages
    if (remaining < 1) throw new Error('参考图已占满输入与输出的合计上限，请减少参考图')
    maximum = maximum === undefined ? remaining : Math.min(maximum, remaining)
  }
  plan.effectiveMaximum = maximum
  if (capability.nativeMultiImage === 'unsupported') {
    plan.effectiveCount = 1
    if (desiredCount > 1) plan.reason = `期望 ${desiredCount} 张，此型号与操作固定单图`
  } else if (capability.countControl === 'uncontrolled') {
    plan.reason = '此接口不能可靠控制返回张数；只执行一次生成，由模型决定返回数量'
  } else if (capability.countControl === 'unknown' || capability.nativeMultiImage === 'unknown') {
    plan.reason = '此模型与接口的张数限制尚未确认；不能设置多图张数'
  } else if (maximum !== undefined) {
    plan.effectiveCount = Math.min(desiredCount, maximum)
    if (plan.effectiveCount < desiredCount) plan.reason = `期望 ${desiredCount} 张，本次上限为 ${maximum} 张`
  }
  return plan
}

export const IMAGE_COUNT_PARAM_KEYS = ['n', 'sampleCount', 'sequential_image_generation', 'sequential_image_generation_options'] as const
export function withoutImageCountParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([key]) => !(IMAGE_COUNT_PARAM_KEYS as readonly string[]).includes(key)))
}

/** 兼容的是厂商当次请求参数，不是旧服务默认值。多份数量不得互相覆盖。 */
export function requestedImageCount(params: Record<string, unknown>, explicit?: number): number | undefined {
  const options = params.sequential_image_generation_options as { max_images?: unknown } | undefined
  const values = [explicit, params.n, params.sampleCount, options?.max_images,
    params.sequential_image_generation === 'disabled' ? 1 : undefined].filter(value => value !== undefined)
  for (const value of values) count.parse(value)
  if (new Set(values).size > 1) throw new Error('本次张数与厂商数量参数冲突，请只指定一个张数')
  return values[0] as number | undefined
}

export const DrawingIntentSchema = z.object({
  serviceId: z.string().min(1), roleId: z.string().min(1).optional(),
  operation: z.enum(IMAGE_OUTPUT_OPERATIONS), desiredCount: count,
  params: z.record(z.string(), z.unknown()), configRevision: z.string().min(1),
  taskId: z.string().min(1).optional(), sourceCandidateId: z.string().min(1).optional(),
}).strict().refine(value => !value.sourceCandidateId || !!value.taskId, '来源候选必须指定绘图任务')
export type DrawingIntent = z.infer<typeof DrawingIntentSchema>
export interface DrawingCandidate {
  candidateId: string; roundId: string; operationId: string; partIndex: number
  assetId: string; assetVersionId: string
}
export interface DrawingRound {
  roundId: string; taskId: string; sourceMessageId: string; feedback: string; intent: DrawingIntent
  inputAssets: Array<{ assetId: string; assetVersionId: string }>
  imageCount: ImageCountPlan; imageConfigRevision: string; imageModel: string; adapter: string
  createdAt: number; operationId?: string; delegatedChatId?: string
  referencesResolved?: boolean
  operation?: Omit<import('./chat.js').FileOperationRecord, 'providerContinuation'>
  candidates: DrawingCandidate[]
}
export interface DrawingTask {
  taskId: string; chatId: string; selectionRevision: number; finalCandidateId?: string
  rounds: DrawingRound[]; createdAt: number
}
