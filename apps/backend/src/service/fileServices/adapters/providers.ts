import { array, dataUri, endpoint, malformed, providerFailure, record, type AdapterHttpContext } from './http.js'
import { invalid } from './params.js'
import {
  FileServiceAdapterError,
  type FileServiceAdapterInput,
  type FileServiceAdapterOutput,
  type FileServiceAdapterPart,
} from './types.js'

function output(parts: FileServiceAdapterPart[], response: Record<string, unknown>): FileServiceAdapterOutput {
  if (!parts.length) malformed('服务未返回文字或图片')
  return {
    parts,
    ...(typeof response.id === 'string' ? { remoteJobId: response.id } : {}),
    ...(response.usage && typeof response.usage === 'object' ? { usage: record(response.usage) } : {}),
  }
}

function mime(format: unknown, fallback = 'png'): string {
  return `image/${typeof format === 'string' ? format : fallback}`
}

function continuation(input: FileServiceAdapterInput, url: URL): Record<string, unknown> {
  const scope = { adapter: input.adapter, model: input.connection.model, endpoint: `${url.origin}${url.pathname}` }
  const previous = input.providerContinuation
  if (previous && Object.entries(scope).some(([key, value]) => previous[key] !== value)) {
    invalid('连续编辑信息不属于当前适配器、模型或端点；请改用本地参考图片')
  }
  return scope
}

export async function minimax(input: FileServiceAdapterInput, p: Record<string, unknown>, ctx: AdapterHttpContext): Promise<FileServiceAdapterOutput> {
  if (input.operation === 'image.edit') invalid('MiniMax 人物参考不是通用图片编辑')
  if (input.assets.length > 1) invalid('MiniMax 人物参考当前只支持一张输入图')
  for (const asset of input.assets) {
    if (!['image/png', 'image/jpeg'].includes(asset.mimeType) || asset.data.length >= 10 * 1024 * 1024) invalid('MiniMax 人物参考必须为小于 10 MiB 的 PNG/JPEG')
  }
  const response = await ctx.request(endpoint(input, 'image_generation', 'v1'), {
    response_format: 'base64', prompt_optimizer: false, ...p, model: input.connection.model,
    ...(input.assets.length ? { subject_reference: input.assets.map((asset) => ({ type: 'character', image_file: dataUri(asset) })) } : {}),
  })
  const status = record(response.base_resp)
  if (status.status_code === undefined) malformed('MiniMax 响应缺少 base_resp.status_code')
  if (status.status_code !== 0) providerFailure(status)
  const data = record(response.data)
  const parts: FileServiceAdapterPart[] = []
  if (array(data.image_base64).length && array(data.image_urls).length) malformed('MiniMax 同时返回了两种图片集合，无法确定对应关系')
  for (const item of array(data.image_base64)) parts.push(ctx.file(item, 'image/jpeg', parts.length))
  for (const item of array(data.image_urls)) parts.push(await ctx.download(item, 'image/jpeg', parts.length))
  return output(parts, response)
}

async function imageData(response: Record<string, unknown>, p: Record<string, unknown>, ctx: AdapterHttpContext): Promise<FileServiceAdapterPart[]> {
  const parts: FileServiceAdapterPart[] = []
  for (const value of array(response.data)) {
    const item = record(value)
    if (item.error) {
      const code = String(record(item.error).code ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128)
      parts.push(ctx.failed('file_service.provider_error', `此图片生成失败（${code}）`, parts.length))
      continue
    }
    if (typeof item.revised_prompt === 'string') parts.push(ctx.text(item.revised_prompt, parts.length))
    const mimeType = mime(item.output_format ?? p.output_format)
    if (typeof item.b64_json === 'string') parts.push(ctx.file(item.b64_json, mimeType, parts.length))
    else if (typeof item.url === 'string') parts.push(await ctx.download(item.url, mimeType, parts.length))
    else malformed('图片结果缺少 b64_json 或 url')
  }
  return parts
}

export async function openaiImages(input: FileServiceAdapterInput, p: Record<string, unknown>, ctx: AdapterHttpContext): Promise<FileServiceAdapterOutput> {
  const edit = input.operation !== 'image.generate'
  if (!edit && (p.maskAssetId || p.input_fidelity)) invalid('maskAssetId/input_fidelity 仅适用于编辑或参考图操作')
  if (p.input_fidelity && input.connection.model === 'gpt-image-1-mini') invalid('gpt-image-1-mini 不支持 input_fidelity')
  const { maskAssetId, response_format: _responseFormat, ...params } = p
  let body: FormData | Record<string, unknown>
  if (edit) {
    const mask = maskAssetId ? input.assets.find((asset) => asset.assetId === maskAssetId) : undefined
    if (maskAssetId && !mask) invalid('maskAssetId 必须引用本次输入资产')
    const images = input.assets.filter((asset) => asset !== mask)
    if (!images.length || images.length > 16) invalid('GPT Image 编辑需要 1–16 张图片（不含蒙版）')
    if (mask && (mask.mimeType !== 'image/png' || mask.data.length >= 4 * 1024 * 1024)) invalid('蒙版必须为小于 4 MiB 的 PNG；尺寸及透明通道由服务商校验')
    body = new FormData()
    body.append('model', input.connection.model)
    for (const [key, value] of Object.entries(params)) body.append(key, String(value))
    for (const [index, asset] of images.entries()) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) || asset.data.length >= 50 * 1024 * 1024) invalid('GPT Image 输入必须为小于 50 MiB 的 PNG/JPEG/WebP')
      body.append('image[]', new Blob([new Uint8Array(asset.data)], { type: asset.mimeType }), `input-${index}.${asset.mimeType.split('/')[1]}`)
    }
    if (mask) body.append('mask', new Blob([new Uint8Array(mask.data)], { type: mask.mimeType }), 'mask.png')
  } else body = { ...params, model: input.connection.model }
  const response = await ctx.request(endpoint(input, `images/${edit ? 'edits' : 'generations'}`, 'v1'), body)
  return output(await imageData(response, p, ctx), response)
}

export async function openaiResponses(input: FileServiceAdapterInput, p: Record<string, unknown>, ctx: AdapterHttpContext): Promise<FileServiceAdapterOutput> {
  const url = endpoint(input, 'responses', 'v1')
  const scope = continuation(input, url)
  const previousId = input.providerContinuation?.responseId
  if (input.providerContinuation && (typeof previousId !== 'string' || !previousId)) invalid('Responses 连续编辑信息缺少 responseId')
  const { prompt, image_model, ...toolParams } = p
  const action = input.operation === 'image.generate' ? 'generate' : 'edit'
  if (p.action && p.action !== 'auto' && p.action !== action) invalid('action 与所选图片操作不一致')
  if (input.assets.length > 16) invalid('Responses 图片操作最多携带 16 张输入图片')
  const content = [
    { type: 'input_text', text: prompt },
    ...input.assets.map((asset) => ({ type: 'input_image', image_url: dataUri(asset) })),
  ]
  const response = await ctx.request(url, {
    model: input.connection.model,
    input: [{ role: 'user', content }],
    tools: [{ type: 'image_generation', ...(image_model ? { model: image_model } : {}), ...toolParams, action: p.action ?? action }],
    tool_choice: { type: 'image_generation' },
    store: true,
    ...(previousId ? { previous_response_id: previousId } : {}),
  })
  if (response.status !== undefined && response.status !== 'completed') {
    providerFailure({ code: `response_${String(response.status)}` })
  }
  const parts: FileServiceAdapterPart[] = []
  for (const value of array(response.output)) {
    const item = record(value)
    if (item.type === 'image_generation_call') {
      if (item.status && item.status !== 'completed') providerFailure({ code: `image_${String(item.status)}` })
      parts.push(ctx.file(item.result, mime(item.output_format ?? p.output_format), parts.length))
    } else if (item.type === 'message') {
      for (const rawPart of array(item.content)) {
        const part = record(rawPart)
        if (part.type === 'output_text' && typeof part.text === 'string') parts.push(ctx.text(part.text, parts.length))
        else if (part.type === 'refusal' && typeof part.refusal === 'string') parts.push(ctx.failed('file_service.provider_error', part.refusal, parts.length))
      }
    }
  }
  if (typeof response.id !== 'string' || !response.id) malformed('Responses 响应缺少续接 ID')
  return { ...output(parts, response), providerContinuation: { ...scope, responseId: response.id } }
}

export async function gemini(input: FileServiceAdapterInput, p: Record<string, unknown>, ctx: AdapterHttpContext): Promise<FileServiceAdapterOutput> {
  const model = encodeURIComponent(input.connection.model.replace(/^models\//, ''))
  const url = endpoint(input, `models/${model}:generateContent`, 'v1beta')
  const scope = continuation(input, url)
  const history = input.providerContinuation?.contents
  if (input.providerContinuation && !Array.isArray(history)) invalid('Gemini 连续编辑信息缺少 contents')
  const current = {
    role: 'user',
    parts: [
      { text: p.prompt },
      ...input.assets.map((asset) => ({ inlineData: { mimeType: asset.mimeType, data: asset.data.toString('base64') } })),
    ],
  }
  const contents: unknown[] = [...(Array.isArray(history) ? history : []), current]
  const response = await ctx.request(url, {
    contents,
    generationConfig: {
      responseModalities: p.responseModalities ?? ['TEXT', 'IMAGE'],
      ...(p.imageConfig ? { imageConfig: p.imageConfig } : {}),
    },
  }, true)
  if (record(response.promptFeedback).blockReason) providerFailure({ code: record(response.promptFeedback).blockReason })
  const parts: FileServiceAdapterPart[] = []
  const candidates = array(response.candidates)
  // There is one requested candidate. Multiple alternatives have no single edit history.
  if (candidates.length > 1) malformed('Gemini 返回多个候选，无法确定连续编辑应使用哪一个')
  for (const candidate of candidates) {
    const c = record(candidate)
    if (c.finishReason && c.finishReason !== 'STOP') providerFailure({ code: c.finishReason })
    const content = record(c.content)
    for (const rawPart of array(content.parts)) {
      const part = record(rawPart)
      // Thought text/images are private continuation, not user-visible deliverables.
      if (part.thought === true) continue
      if (typeof part.text === 'string') parts.push(ctx.text(part.text, parts.length))
      if (part.inlineData) {
        const data = record(part.inlineData)
        if (typeof data.mimeType !== 'string') malformed('Gemini 图片缺少 mimeType')
        parts.push(ctx.file(data.data, data.mimeType, parts.length))
      }
    }
    // Keep complete content including thoughtSignature on its original part.
    contents.push({ ...content, role: 'model' })
  }
  return {
    ...output(parts, {}),
    ...(response.usageMetadata ? { usage: record(response.usageMetadata) } : {}),
    ...(typeof response.responseId === 'string' ? { remoteJobId: response.responseId } : {}),
    providerContinuation: { ...scope, contents },
  }
}

export async function imagen(input: FileServiceAdapterInput, p: Record<string, unknown>, ctx: AdapterHttpContext): Promise<FileServiceAdapterOutput> {
  if (input.operation !== 'image.generate' || input.assets.length) invalid('Imagen 文生图接口不支持参考图片或编辑')
  if (!input.connection.endpoints?.[input.operation] || input.connection.authType !== 'bearer') invalid('Gemini API 的 Imagen 已停用。Vertex AI Imagen 需要明确填写项目/地区完整 predict 端点并选择 Bearer 访问令牌认证')
  const { prompt, ...parameters } = p
  const model = encodeURIComponent(input.connection.model.replace(/^models\//, ''))
  const response = await ctx.request(endpoint(input, `models/${model}:predict`, 'v1beta'), {
    instances: [{ prompt }], parameters,
  }, true)
  const parts: FileServiceAdapterPart[] = []
  for (const raw of array(response.predictions)) {
    const item = record(raw)
    if (item.raiFilteredReason) {
      parts.push(ctx.failed('file_service.provider_error', '此图片被服务商的内容检查阻止', parts.length))
      continue
    }
    if (typeof item.mimeType !== 'string') malformed('Imagen 输出缺少 mimeType')
    parts.push(ctx.file(item.bytesBase64Encoded, item.mimeType, parts.length))
  }
  return output(parts, response)
}

export async function seedream(input: FileServiceAdapterInput, p: Record<string, unknown>, ctx: AdapterHttpContext): Promise<FileServiceAdapterOutput> {
  const modernSingle = /^doubao-seedream-5-0-(pro|flash)-/.test(input.connection.model)
  const maxInputs = modernSingle ? 10 : 14
  if (input.assets.length > maxInputs) invalid(`当前 Seedream 模式最多支持 ${maxInputs} 张参考图片`)
  if (p.sequential_image_generation === 'auto') {
    const count = Number(record(p.sequential_image_generation_options).max_images ?? 15)
    if (input.assets.length + count > 15) invalid('Seedream 参考图片数与最大输出图片数之和不能超过 15')
  }
  for (const asset of input.assets) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType) || asset.data.length > 10 * 1024 * 1024) invalid('Seedream 参考图必须为不超过 10 MiB 的 PNG/JPEG/WebP')
  }
  const images = input.assets.map(dataUri)
  const response = await ctx.request(endpoint(input, 'images/generations', 'api/v3'), {
    response_format: 'b64_json', ...p, model: input.connection.model, stream: false,
    ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
  })
  return output(await imageData(response, { ...p, output_format: p.output_format ?? 'jpeg' }, ctx), response)
}

export const providerExecutors = {
  'minimax-images': minimax,
  'openai-images': openaiImages,
  'openai-responses-image': openaiResponses,
  'google-gemini-image': gemini,
  'google-imagen': imagen,
  'doubao-seedream': seedream,
}

export function assertInput(input: FileServiceAdapterInput): void {
  if (!Object.hasOwn(providerExecutors, input.adapter)) throw new FileServiceAdapterError('capability.unavailable', '未实现此 HTTP 文件适配器')
  if (!['image.generate', 'image.reference', 'image.edit'].includes(input.operation)) invalid('此适配器只支持已声明的图片生成、参考或编辑操作')
  if (input.adapter === 'minimax-images' && input.operation === 'image.edit') invalid('MiniMax 不支持通用编辑')
  if (input.adapter === 'google-imagen' && input.operation !== 'image.generate') invalid('Imagen 仅支持文生图')
  if (!input.connection.model.trim()) invalid('必须明确配置模型或接入点 ID')
  if (input.providerContinuation && !['openai-responses-image', 'google-gemini-image'].includes(input.adapter)) invalid('此接口不支持连续编辑信息；请显式引用本地图片')
  if (input.operation === 'image.generate' && input.assets.length) invalid('文生图操作不能携带输入图片，请使用参考或编辑操作')
  if (input.operation !== 'image.generate' && !input.assets.length && !input.providerContinuation) invalid('参考或编辑操作需要输入图片或有效连续编辑信息')
  for (const asset of input.assets) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mimeType) || !asset.data.length) invalid('输入资产必须是非空且受支持的图片')
    if (asset.data.length > 100 * 1024 * 1024) invalid('单张输入图片不能超过 100 MiB')
  }
}
