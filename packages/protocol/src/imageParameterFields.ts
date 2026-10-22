import { FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, type HttpFileServiceAdapterId } from './fileServiceParams.js'
import { IMAGE_COUNT_PARAM_KEYS } from './imageGeneration.js'

export interface ImageParameterField {
  type?: string; enum?: Array<string | number | boolean>; const?: unknown
  minimum?: number; maximum?: number; multipleOf?: number
  properties?: Record<string, ImageParameterField>; items?: ImageParameterField
}
export interface ImageParameterContext {
  adapter: string
  model?: string
  operation?: string
  operations?: readonly string[]
  params: Record<string, unknown>
}
export interface ImageParameterDisplay {
  value?: unknown
  text: string
  source: 'service' | 'project' | 'provider' | 'unknown'
  applicable?: boolean
  required?: boolean
}

/** Display only: callers keep the original overrides, including explicit default values. */
export function imageParameterDisplay(context: ImageParameterContext, path: string, inherited?: Record<string, unknown>): ImageParameterDisplay {
  const get = (object: Record<string, unknown> | undefined) => path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, object)
  const fromService = get(inherited)
  if (fromService !== undefined) return { value: fromService, text: `${display(fromService)} · 服务设置`, source: 'service' }
  const { adapter, params } = context
  const model = adapter === 'openai-responses-image' ? String(params.image_model ?? 'gpt-image-1') : context.model ?? ''
  const known = (value: unknown, source: 'project' | 'provider' = 'provider', text = display(value)): ImageParameterDisplay => ({ value, text: `${text} · ${source === 'project' ? '项目默认' : '服务默认'}`, source })
  const none = (text: string, applicable = true): ImageParameterDisplay => ({ text, source: 'project', applicable })
  if (adapter === 'minimax-images') {
    if (path === 'aspect_ratio') return params.width !== undefined || params.height !== undefined ? none('使用成对宽高，不额外指定比例', false) : known('1:1', 'provider', '1:1（1024×1024）')
    if (path === 'width' || path === 'height') return { ...none(params.width !== undefined || params.height !== undefined ? '宽高模式：两项必须同时填写' : '未使用宽高模式'), required: params.width !== undefined || params.height !== undefined }
    if (path === 'response_format') return known('base64', 'project', 'Base64')
    if (['prompt_optimizer', 'aigc_watermark'].includes(path)) return known(false)
    if (path === 'seed') return none('随机种子 · 服务默认')
    if (path === 'style') return none('未指定画风')
    if (path === 'style.style_type') return { ...none('选择画风后必填'), required: !!params.style && Object.keys(params.style as object).length > 0 }
    if (path === 'style.style_weight') return known(0.8)
  }
  if (adapter.startsWith('openai-')) {
    if (['size', 'quality', 'background'].includes(path)) return known('auto', 'provider', '自动')
    if (path === 'output_format') return known('png', 'provider', 'PNG')
    if (path === 'output_compression') return ['jpeg', 'webp'].includes(String(params.output_format)) ? known(100) : none('仅在明确选择 JPEG/WebP 后适用', false)
    if (path === 'moderation') {
      const operations = context.operations ?? (context.operation ? [context.operation] : [])
      if (adapter === 'openai-images' && operations.some(op => op !== 'image.generate')) return { text: operations.includes('image.generate') ? '生成：auto；multipart 编辑：默认未核实' : '未设置 · 默认未核实（multipart 编辑）', source: 'unknown' }
      return known('auto')
    }
    if (path === 'input_fidelity') return known('low', 'provider', '低（low）')
    if (path === 'image_model') return known('gpt-image-1')
    if (path === 'partial_images') return known(0, 'project', '不请求部分预览（0）')
    if (path === 'action') return context.operation ? known(context.operation === 'image.generate' ? 'generate' : 'edit', 'project') : none('按当次操作使用 generate / edit · 项目默认')
    if (path === 'response_format') return known('b64_json', 'project', '固定 Base64')
    if (path === 'maskAssetId') return none('未使用蒙版')
  }
  if (adapter === 'google-gemini-image') {
    if (path === 'responseModalities') return known(['TEXT', 'IMAGE'], 'project', '文本和图片')
    if (path === 'imageConfig') return none('比例和尺寸默认未核实')
    if (path.startsWith('imageConfig.')) return { text: '未设置 · 默认未核实', source: 'unknown' }
  }
  if (adapter === 'doubao-seedream') {
    const modern = /^doubao-seedream-5-0-(pro|flash)(?:-|$)/.test(model)
    if (path === 'size') return modern ? known('2K', 'provider', '2K（宽高按提示确定）') : known('2048x2048', 'provider', '2048×2048')
    if (path === 'output_format') return modern && params.background === 'transparent' ? known('png', 'provider', 'PNG（透明背景）') : known('jpeg', 'provider', 'JPEG')
    if (path === 'background') return known('opaque')
    if (path === 'response_format') return known('b64_json', 'project', 'Base64')
    if (path === 'stream') return known(false, 'project', '非流式')
    if (path === 'watermark') return known(true)
    if (path === 'optimize_prompt_options.mode') return known('standard')
    if (path === 'seed') return { text: '未设置 · 默认未核实', source: 'unknown' }
  }
  return { text: '未设置 · 默认未核实', source: 'unknown' }
}
function display(value: unknown): string {
  return value === true ? '开启' : value === false ? '关闭' : Array.isArray(value) ? value.join('、') : String(value)
}
export function mergeImageParameters(inherited: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const result = { ...inherited, ...overrides }
  for (const key of ['style', 'imageConfig', 'outputOptions', 'optimize_prompt_options']) {
    const left = inherited[key], right = overrides[key]
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) result[key] = { ...left, ...right }
  }
  return result
}

/** 表单仅显示已实现的型号参数；后端仍逐项验证，不据此自动改写已有草稿。 */
export function imageParameterFields(adapter: string, model = ''): Record<string, ImageParameterField> {
  if (!Object.hasOwn(FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, adapter)) return {}
  const schema = FILE_SERVICE_ADAPTER_PARAM_SCHEMAS[adapter as HttpFileServiceAdapterId].toJSONSchema() as { properties?: Record<string, ImageParameterField> }
  const fields = JSON.parse(JSON.stringify(schema.properties ?? {})) as Record<string, ImageParameterField>
  for (const key of ['prompt', ...IMAGE_COUNT_PARAM_KEYS, 'sequential_image_generation_options']) delete fields[key]
  if (adapter === 'minimax-images') {
    if (model !== 'image-01') { delete fields.width; delete fields.height; fields.aspect_ratio!.enum = fields.aspect_ratio!.enum?.filter(value => value !== '21:9') }
    if (model !== 'image-01-live') delete fields.style
  }
  if (adapter.startsWith('openai-')) {
    const modern = /^gpt-image-2\.5-(sunburst|flare)$/.test(model)
    if (!modern) { fields.size!.enum = ['auto', '1024x1024', '1536x1024', '1024x1536']; fields.quality!.enum = ['low', 'medium', 'high', 'auto'] }
    if (modern || model === 'gpt-image-2' || model === 'gpt-image-1-mini') delete fields.input_fidelity
  }
  if (adapter === 'google-gemini-image') {
    const image = fields.imageConfig!.properties!
    if (model === 'gemini-2.5-flash-image') delete image.imageSize
    else if (/^gemini-3\.1-flash-lite-image(?:-preview)?$/.test(model)) image.imageSize!.enum = ['1K']
    else if (!/^gemini-3\.1-flash-image(?:-preview)?$/.test(model)) image.imageSize!.enum = ['1K', '2K', '4K']
  }
  if (adapter === 'doubao-seedream') {
    if (/^doubao-seedream-5-0-(pro|flash)(?:-|$)/.test(model)) {
      delete fields.seed
      if (/^doubao-seedream-5-0-flash(?:-|$)/.test(model)) fields.optimize_prompt_options!.properties!.mode!.enum = ['standard']
    } else { delete fields.background; delete fields.optimize_prompt_options }
  }
  return fields
}

export function imageParameterFieldsForContext(context: ImageParameterContext) {
  const model = context.adapter === 'openai-responses-image' ? String(context.params.image_model ?? 'gpt-image-1') : context.model
  const fields = imageParameterFields(context.adapter, model)
  if (context.operation === 'image.generate' || context.operations?.every(op => op === 'image.generate')) { delete fields.input_fidelity; delete fields.maskAssetId }
  return fields
}
