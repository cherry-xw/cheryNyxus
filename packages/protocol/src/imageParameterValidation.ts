import { FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, type HttpFileServiceAdapterId } from './fileServiceParams.js'

/** Same checks before saving defaults and before submitting a concrete request. No transport. */
export function imageParameterErrors(adapter: string, params: Record<string, unknown>, model: string): string[] {
  if (!Object.hasOwn(FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, adapter)) return []
  const parsed = FILE_SERVICE_ADAPTER_PARAM_SCHEMAS[adapter as HttpFileServiceAdapterId].safeParse(params)
  if (!parsed.success) return parsed.error.issues.map(issue => `${issue.path.join('.') || 'params'}: ${issue.message}`)
  const p: Record<string, unknown> = parsed.data
  const errors: string[] = []
  const invalid = (message: string) => { errors.push(message) }
  if (adapter === 'minimax-images') {
    if ((p.width === undefined) !== (p.height === undefined)) invalid('width 与 height 必须同时设置')
    if (p.width !== undefined && p.aspect_ratio !== undefined) invalid('aspect_ratio 与 width/height 不能同时设置')
    if (p.width !== undefined && model !== 'image-01') invalid('width/height 仅支持 image-01')
    if (p.aspect_ratio === '21:9' && model !== 'image-01') invalid('21:9 仅支持 image-01')
    if (p.style !== undefined && model !== 'image-01-live') invalid('style 仅支持 image-01-live')
  }
  if (adapter.startsWith('openai-')) {
    const imageModel = adapter === 'openai-responses-image' ? String(p.image_model ?? '') : model
    const image25 = /^gpt-image-2\.5-(sunburst|flare)$/.test(imageModel)
    if (['xhigh', 'max'].includes(String(p.quality)) && !image25) invalid('quality: xhigh/max 图片质量仅对已确认的 GPT Image 2.5 型号开放；Responses 请显式设置 image_model')
    if (p.size && !['auto', '1024x1024', '1536x1024', '1024x1536'].includes(String(p.size))) {
      if (!image25) invalid('size: 自定义图片尺寸仅对已确认的 GPT Image 2.5 型号开放')
      else {
        const [width, height] = String(p.size).split('x').map(Number)
        if (!width || !height || width > 3840 || height > 3840 || width % 16 || height % 16 || Math.max(width, height) / Math.min(width, height) > 3 || width * height < 655360 || width * height > 8294400) invalid('size: GPT Image 2.5 尺寸必须为 16 的倍数、每边不超过 3840、比例不超过 3:1、总像素在 655360–8294400')
      }
    }
    if (image25 && p.input_fidelity !== undefined) invalid('input_fidelity: GPT Image 2.5 的 input_fidelity 未确认，请删除该旧代参数')
    if (model === 'gpt-image-2' && p.input_fidelity !== undefined) invalid('input_fidelity: gpt-image-2 自动使用高保真输入，不允许设置 input_fidelity')
    if (p.output_compression !== undefined && !['jpeg', 'webp'].includes(String(p.output_format))) invalid('output_compression 需要明确选择 jpeg 或 webp')
    if (p.background === 'transparent' && p.output_format === 'jpeg') invalid('background: JPEG 不支持透明背景')
    if (/^dall-e-/i.test(model) && adapter === 'openai-images') invalid('model: 此适配器实现 GPT Image 参数，不支持 DALL·E 参数模式')
  }
  if (adapter === 'google-gemini-image') {
    const imageSize = (p.imageConfig as { imageSize?: string } | undefined)?.imageSize
    if (imageSize === '512' && !/^gemini-3\.1-flash-image(?:-preview)?$/.test(model)) invalid('imageConfig.imageSize: 512 图片尺寸仅支持 Gemini 3.1 Flash Image')
    if (/^gemini-3\.1-flash-lite-image(?:-preview)?$/.test(model) && imageSize && imageSize !== '1K') invalid('imageConfig.imageSize: Gemini 3.1 Flash Lite Image 仅支持 1K')
    if (p.responseModalities && !(p.responseModalities as string[]).includes('IMAGE')) invalid('responseModalities: 图片操作必须请求 IMAGE 输出')
    if (model === 'gemini-2.5-flash-image' && imageSize) invalid('imageConfig.imageSize: gemini-2.5-flash-image 不支持 imageSize')
  }
  if (adapter === 'google-imagen' && model === 'imagen-4.0-ultra-generate-001' && Number(p.sampleCount ?? 1) > 1) invalid('sampleCount: Imagen 4 Ultra 每次仅支持一张图片')
  if (adapter === 'doubao-seedream') {
    if (p.sequential_image_generation_options && p.sequential_image_generation !== 'auto') invalid('sequential_image_generation_options: 组图配置需要 auto 模式')
    const modern = /^doubao-seedream-5-0-(pro|flash)(?:-|$)/.test(model)
    if (modern && (p.sequential_image_generation !== undefined || p.seed !== undefined)) invalid('Seedream 5.0 pro/flash 不支持组图参数或 seed；请删除这些参数')
    if (modern && p.size !== undefined && !['1K', '1.5K', '2K'].includes(String(p.size))) {
      const [width, height] = String(p.size).split('x').map(Number)
      if (!width || !height || width * height < 921600 || width * height > 4624220 || width / height < 1 / 16 || width / height > 16) invalid('size: Seedream 5.0 pro/flash 生图尺寸须为 1K/1.5K/2K 或合法像素尺寸，不支持 4K/auto')
    }
    if (!modern && (p.background !== undefined || p.optimize_prompt_options !== undefined || p.size === '1.5K' || p.size === 'auto')) invalid('该 Seedream 型号尚未确认这些新参数')
    if (/^doubao-seedream-5-0-flash(?:-|$)/.test(model) && (p.optimize_prompt_options as { mode?: string } | undefined)?.mode === 'fast') invalid('optimize_prompt_options.mode: Seedream 5.0 flash 只支持 standard 提示词优化模式')
    if (p.background === 'transparent' && p.output_format === 'jpeg') invalid('output_format: 透明输出必须为 PNG')
  }
  return errors
}
