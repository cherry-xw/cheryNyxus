import { FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, type HttpFileServiceAdapterId } from '@chery/protocol'
import { FileServiceAdapterError } from './types.js'
export { FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, type HttpFileServiceAdapterId } from '@chery/protocol'

export function invalid(message: string): never {
  throw new FileServiceAdapterError('file_service.invalid_params', message)
}

export function validateFileServiceAdapterParams(adapter: string, params: Record<string, unknown>, model: string): Record<string, unknown> {
  if (!Object.hasOwn(FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, adapter)) throw new FileServiceAdapterError('capability.unavailable', `不支持 HTTP 文件适配器：${adapter}`)
  const parsed = FILE_SERVICE_ADAPTER_PARAM_SCHEMAS[adapter as HttpFileServiceAdapterId].safeParse(params)
  if (!parsed.success) invalid(parsed.error.issues.map(issue => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; '))
  const p: Record<string, unknown> = parsed.data
  if (adapter === 'minimax-images') {
    if ((p.width === undefined) !== (p.height === undefined)) invalid('width 与 height 必须同时设置')
    if (p.width !== undefined && p.aspect_ratio !== undefined) invalid('aspect_ratio 与 width/height 不能同时设置')
    if (p.width !== undefined && model !== 'image-01') invalid('width/height 仅支持 image-01')
    if (p.aspect_ratio === '21:9' && model !== 'image-01') invalid('21:9 仅支持 image-01')
    if (p.style !== undefined && model !== 'image-01-live') invalid('style 仅支持 image-01-live')
  }
  if (adapter.startsWith('openai-')) {
    if (model === 'gpt-image-2' && p.input_fidelity !== undefined) invalid('gpt-image-2 自动使用高保真输入，不允许设置 input_fidelity')
    if (p.output_compression !== undefined && !['jpeg', 'webp'].includes(String(p.output_format))) invalid('output_compression 需要明确选择 jpeg 或 webp')
    if (p.background === 'transparent' && p.output_format === 'jpeg') invalid('JPEG 不支持透明背景')
    if (/^dall-e-/i.test(model) && adapter === 'openai-images') invalid('此适配器实现 GPT Image 参数，不支持 DALL·E 参数模式')
  }
  if (adapter === 'google-gemini-image') {
    if (p.responseModalities && !(p.responseModalities as string[]).includes('IMAGE')) invalid('图片操作必须请求 IMAGE 输出')
    if (model === 'gemini-2.5-flash-image' && (p.imageConfig as Record<string, unknown> | undefined)?.imageSize) invalid('gemini-2.5-flash-image 不支持 imageSize')
  }
  if (adapter === 'google-imagen' && model === 'imagen-4.0-ultra-generate-001' && Number(p.sampleCount ?? 1) > 1) invalid('Imagen 4 Ultra 每次仅支持一张图片')
  if (adapter === 'doubao-seedream') {
    if (p.sequential_image_generation_options && p.sequential_image_generation !== 'auto') invalid('组图配置需要 auto 模式')
    if (/^doubao-seedream-5-0-(pro|flash)-/.test(model) && (p.sequential_image_generation !== undefined || p.seed !== undefined)) invalid('Seedream 5.0 pro/flash 不支持组图参数或 seed；请删除这些参数')
  }
  return p
}
