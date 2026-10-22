import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  executeFileServiceAdapter,
  FileServiceAdapterError,
  MAX_FILE_SERVICE_OUTPUT_BYTES,
  validateFileServiceAdapterParams,
  type FileServiceAdapterInput,
} from '@/service/fileServices/adapters/index.js'

// These are opaque text fixtures, not image files or image-content assertions.
const first = Buffer.from('first fixture').toString('base64')
const second = Buffer.from('second fixture').toString('base64')
const asset = { assetId: 'a', assetVersionId: 'v1', mimeType: 'image/png', data: Buffer.from('input fixture') }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
function input(adapter = 'minimax-images', overrides: Partial<FileServiceAdapterInput> = {}): FileServiceAdapterInput {
  return {
    adapter, operation: 'image.generate',
    connection: { baseUrl: 'https://provider.example', model: 'image-01', key: 'secret-value' },
    params: { prompt: 'draw a tree' }, assets: [], ...overrides,
  }
}
function mockFetch(body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(async () => json(body))
}
function requestBody(fetcher: ReturnType<typeof mockFetch>): Record<string, unknown> {
  return JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
}

afterEach(() => vi.useRealTimers())

describe('文件服务 HTTP 适配器', () => {
  it('Gemini maps saved imageConfig to current native responseFormat.image', async () => {
    const fetcher = mockFetch({ candidates: [{ content: { parts: [{ inlineData: { data: first, mimeType: 'image/png' } }] } }] })
    await executeFileServiceAdapter(input('google-gemini-image', { connection: { baseUrl: 'https://provider.example/v1beta', model: 'gemini-3.1-flash-image' }, params: { prompt: 'synthetic', imageConfig: { imageSize: '512', aspectRatio: '16:9' } } }), { fetch: fetcher })
    expect(requestBody(fetcher).generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], responseFormat: { image: { imageSize: '512', aspectRatio: '16:9' } } })
    expect(() => validateFileServiceAdapterParams('google-gemini-image', { prompt: 'synthetic', imageConfig: { imageSize: '4K' } }, 'gemini-3.1-flash-lite-image')).toThrow()
  })
  it.each(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'])('GPT Image 2.5 %s forwards explicit quality and custom dimensions without a paid request', async model => {
    const fetcher = mockFetch({ data: [{ b64_json: first }] })
    await executeFileServiceAdapter(input('openai-images', { connection: { baseUrl: 'https://provider.example/v1', model }, params: { prompt: 'synthetic', quality: 'xhigh', size: '3840x2160', output_format: 'png' } }), { fetch: fetcher })
    expect(requestBody(fetcher)).toMatchObject({ model, quality: 'xhigh', size: '3840x2160' })
    expect(() => validateFileServiceAdapterParams('openai-images', { prompt: 'synthetic', size: '3841x2160' }, model)).toThrow()
    expect(() => validateFileServiceAdapterParams('openai-images', { prompt: 'synthetic', input_fidelity: 'high' }, model)).toThrow()
  })

  it('old GPT image models do not inherit new quality or size controls', () => {
    expect(() => validateFileServiceAdapterParams('openai-images', { prompt: 'synthetic', quality: 'max' }, 'gpt-image-1.5')).toThrow()
    expect(() => validateFileServiceAdapterParams('openai-images', { prompt: 'synthetic', size: '3840x2160' }, 'gpt-image-1.5')).toThrow()
  })

  it.each(['doubao-seedream-5-0-pro-260628', 'doubao-seedream-5-0-flash-260915'])('%s accepts 1.5K and rejects unsupported resolution/effort fields', async model => {
    const fetcher = mockFetch({ data: [{ b64_json: first }] })
    await executeFileServiceAdapter(input('doubao-seedream', { connection: { baseUrl: 'https://provider.example/api/v3', model }, params: { prompt: 'synthetic', size: '1.5K', optimize_prompt_options: { mode: 'standard' } } }), { fetch: fetcher })
    expect(requestBody(fetcher)).toMatchObject({ size: '1.5K', optimize_prompt_options: { mode: 'standard' }, stream: false })
    for (const params of [{ size: '4K' }, { size: '512x512' }, { seed: 1 }, { layer_decomposition: true }]) expect(() => validateFileServiceAdapterParams('doubao-seedream', { prompt: 'synthetic', ...params }, model)).toThrow()
  })

  it('Seedream pro fast is explicit; flash fast is rejected, transparency requires reference', async () => {
    expect(validateFileServiceAdapterParams('doubao-seedream', { prompt: 'synthetic', optimize_prompt_options: { mode: 'fast' } }, 'doubao-seedream-5-0-pro-260628')).toHaveProperty('optimize_prompt_options')
    expect(() => validateFileServiceAdapterParams('doubao-seedream', { prompt: 'synthetic', optimize_prompt_options: { mode: 'fast' } }, 'doubao-seedream-5-0-flash-260915')).toThrow()
    const fetcher = mockFetch({ data: [{ b64_json: first }] })
    await expect(executeFileServiceAdapter(input('doubao-seedream', { connection: { baseUrl: 'https://provider.example/api/v3', model: 'doubao-seedream-5-0-pro-260628' }, params: { prompt: 'synthetic', background: 'transparent' } }), { fetch: fetcher })).rejects.toMatchObject({ code: 'file_service.invalid_params' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('最小检查：MiniMax 保留全部图片并请求 base64', async () => {
    const fetcher = mockFetch({ base_resp: { status_code: 0 }, id: 'remote-1', data: { image_base64: [first, second] } })
    const result = await executeFileServiceAdapter(input(), { fetch: fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://provider.example/v1/image_generation')
    expect(requestBody(fetcher)).toMatchObject({ model: 'image-01', response_format: 'base64', prompt_optimizer: false })
    expect(result.parts.map((part) => part.type === 'file' ? part.data.toString() : part.text)).toEqual(['first fixture', 'second fixture'])
    expect(result.remoteJobId).toBe('remote-1')
  })

  it('MiniMax 人物参考发送 data URL，不把人物参考称为通用编辑', async () => {
    const fetcher = mockFetch({ base_resp: { status_code: 0 }, data: { image_base64: [first] } })
    await executeFileServiceAdapter(input('minimax-images', { operation: 'image.reference', assets: [asset] }), { fetch: fetcher })
    expect(requestBody(fetcher).subject_reference).toEqual([{ type: 'character', image_file: `data:image/png;base64,${asset.data.toString('base64')}` }])
    await expect(executeFileServiceAdapter(input('minimax-images', { operation: 'image.edit', assets: [asset] }), { fetch: fetcher })).rejects.toMatchObject({ code: 'file_service.invalid_params' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('HTTP 200 中 MiniMax 错误仍失败，并保留厂商码而不泄露正文', async () => {
    const fetcher = mockFetch({ base_resp: { status_code: 1008, status_msg: 'secret-value' } })
    const error = await executeFileServiceAdapter(input(), { fetch: fetcher }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FileServiceAdapterError)
    expect(error).toMatchObject({ code: 'file_service.provider_error', providerCode: '1008' })
    expect(String(error)).not.toContain('secret-value')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('OpenAI Images 生成走 JSON，API 基础地址不重复拼接 v1', async () => {
    const fetcher = mockFetch({ data: [{ revised_prompt: 'revised', b64_json: first }, { b64_json: second }], usage: { total_tokens: 42 } })
    const result = await executeFileServiceAdapter(input('openai-images', {
      connection: { baseUrl: 'https://provider.example/v1/', model: 'gpt-image-1' },
      params: { prompt: '  preserve whitespace  ', n: 2, output_format: 'webp' },
    }), { fetch: fetcher })
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://provider.example/v1/images/generations')
    expect(requestBody(fetcher)).toMatchObject({ prompt: '  preserve whitespace  ', n: 2 })
    expect(requestBody(fetcher)).not.toHaveProperty('response_format')
    expect(result.parts.map((p) => p.type)).toEqual(['text', 'file', 'file'])
    expect(result.usage).toEqual({ total_tokens: 42 })
  })

  it('OpenAI 编辑发送全部图片与单独蒙版的 multipart，不手写 Content-Type', async () => {
    const fetcher = mockFetch({ data: [{ b64_json: first }] })
    const mask = { ...asset, assetId: 'mask', data: Buffer.from('mask fixture') }
    await executeFileServiceAdapter(input('openai-images', {
      operation: 'image.edit', assets: [asset, { ...asset, assetId: 'b' }, mask],
      connection: { baseUrl: 'https://provider.example/v1', model: 'gpt-image-1' },
      params: { prompt: 'edit', maskAssetId: 'mask', input_fidelity: 'high' },
    }), { fetch: fetcher })
    const options = fetcher.mock.calls[0]![1]!
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://provider.example/v1/images/edits')
    expect(options.body).toBeInstanceOf(FormData)
    const form = options.body as FormData
    expect(form.getAll('image[]')).toHaveLength(2)
    expect(form.get('mask')).toBeInstanceOf(Blob)
    expect(form.has('maskAssetId')).toBe(false)
    expect(options.headers).not.toHaveProperty('Content-Type')
  })

  it('端点覆盖是完整地址，不拼接路径，不跟随重定向', async () => {
    const fetcher = mockFetch({ data: [{ b64_json: first }] })
    await executeFileServiceAdapter(input('openai-images', {
      connection: { baseUrl: 'https://unused.example', model: 'manual-model', key: 'key', endpoints: { 'image.generate': 'https://provider.example/custom?revision=1' } },
    }), { fetch: fetcher })
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://provider.example/custom?revision=1')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error', credentials: 'omit' })
  })

  it('Responses 保持文字/图片交错顺序，并将 response ID 用于下一次编辑', async () => {
    const fetcher = mockFetch({ id: 'resp-1', status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'before' }] },
      { type: 'image_generation_call', id: 'ig-1', status: 'completed', result: first, output_format: 'png' },
      { type: 'message', content: [{ type: 'output_text', text: 'between' }] },
      { type: 'image_generation_call', id: 'ig-2', status: 'completed', result: second },
    ], usage: { output_tokens: 3 } })
    const original = input('openai-responses-image', { connection: { baseUrl: 'https://provider.example/v1', model: 'configured-chat-model' } })
    const result = await executeFileServiceAdapter(original, { fetch: fetcher })
    expect(result.parts.map((p) => p.type === 'text' ? p.text : p.data.toString())).toEqual(['before', 'first fixture', 'between', 'second fixture'])
    fetcher.mockResolvedValueOnce(json({ id: 'resp-2', status: 'completed', output: [{ type: 'image_generation_call', result: first }] }))
    await executeFileServiceAdapter({ ...original, operation: 'image.edit', providerContinuation: result.providerContinuation }, { fetch: fetcher })
    const body = JSON.parse(fetcher.mock.calls[1]![1]!.body as string)
    expect(body.previous_response_id).toBe('resp-1')
    expect(body.tools).toEqual([{ type: 'image_generation', action: 'edit' }])
    expect(body.store).toBe(true)
  })

  it('Responses 纯文字拒绝不伪造图片；异步未完成状态不报成功', async () => {
    const fetcher = mockFetch({ id: 'resp-1', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot comply' }] }] })
    const result = await executeFileServiceAdapter(input('openai-responses-image'), { fetch: fetcher })
    expect(result.parts).toEqual([{ type: 'text', text: 'cannot comply' }])
    fetcher.mockResolvedValueOnce(json({ id: 'resp-2', status: 'in_progress' }))
    await expect(executeFileServiceAdapter(input('openai-responses-image'), { fetch: fetcher })).rejects.toMatchObject({ providerCode: 'response_in_progress' })
  })

  it('Gemini 保留文字多图顺序及原位置签名，下一轮回传完整 content', async () => {
    const modelContent = { role: 'model', parts: [
      { text: 'private thought', thought: true, thoughtSignature: 'private-signature' },
      { text: 'before', thoughtSignature: 'text-signature' },
      { inlineData: { data: first, mimeType: 'image/png' }, thoughtSignature: 'image-signature' },
      { text: 'after' },
      { inlineData: { data: second, mimeType: 'image/jpeg' } },
    ] }
    const fetcher = mockFetch({ candidates: [{ finishReason: 'STOP', content: modelContent }], usageMetadata: { candidatesTokenCount: 12 } })
    const original = input('google-gemini-image', { connection: { baseUrl: 'https://provider.example/v1beta', model: 'gemini-2.5-flash-image', key: 'google-key' } })
    const result = await executeFileServiceAdapter(original, { fetch: fetcher })
    expect(result.parts.map((p) => p.type === 'text' ? p.text : p.data.toString())).toEqual(['before', 'first fixture', 'after', 'second fixture'])
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({ 'x-goog-api-key': 'google-key' })
    expect(fetcher.mock.calls[0]![1]!.headers).not.toHaveProperty('Authorization')
    expect(result.providerContinuation?.contents).toEqual([{ role: 'user', parts: [{ text: 'draw a tree' }] }, modelContent])
    await executeFileServiceAdapter({ ...original, operation: 'image.edit', providerContinuation: result.providerContinuation }, { fetch: fetcher })
    const body = JSON.parse(fetcher.mock.calls[1]![1]!.body as string)
    expect(body.contents[1]).toEqual(modelContent)
    expect(body.contents).toHaveLength(3)
  })

  it('连续编辑信息禁止跨模型或跨服务端点使用', async () => {
    const fetcher = mockFetch({})
    await expect(executeFileServiceAdapter(input('google-gemini-image', {
      providerContinuation: { adapter: 'google-gemini-image', model: 'other-model', endpoint: 'https://provider.example/v1beta/models/other-model:generateContent', contents: [] },
    }), { fetch: fetcher })).rejects.toMatchObject({ code: 'file_service.invalid_params' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('Gemini 多 candidate 的最终图全部保存，思考图不计数，也不构造共用续接', async () => {
    const fetcher = mockFetch({ candidates: [
      { finishReason: 'STOP', content: { parts: [{ thought: true, inlineData: { data: first, mimeType: 'image/png' } }, { inlineData: { data: first, mimeType: 'image/png' } }] } },
      { finishReason: 'STOP', content: { parts: [{ inlineData: { data: second, mimeType: 'image/png' } }] } },
    ] })
    const result = await executeFileServiceAdapter(input('google-gemini-image'), { fetch: fetcher })
    expect(result.parts).toHaveLength(2)
    expect(result.receivedImageCount).toBe(2)
    expect(result.providerContinuation).toBeUndefined()
    expect(result.incomplete?.code).toBe('file_service.multiple_candidates')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('MiniMax 单次返回不足时保留明确失败数，不用差值伪造失败', async () => {
    const fetcher = mockFetch({ base_resp: { status_code: 0 }, data: { image_base64: [first] }, metadata: { failed_count: 1 } })
    const result = await executeFileServiceAdapter(input('minimax-images', { params: { prompt: 'test', n: 3 } }), { fetch: fetcher })
    expect(result.receivedImageCount).toBe(1)
    expect(result.reportedFailedImageCount).toBe(1)
    expect(result.incomplete).toMatchObject({ retryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('Imagen 使用 predict 的 instances/parameters 并解析所有 predictions', async () => {
    const fetcher = mockFetch({ predictions: [{ bytesBase64Encoded: first, mimeType: 'image/png' }, { bytesBase64Encoded: second, mimeType: 'image/jpeg' }] })
    const result = await executeFileServiceAdapter(input('google-imagen', {
      connection: { baseUrl: 'https://provider.example', model: 'imagen-4.0-generate-001', authType: 'bearer', key: 'vertex-token',
        endpoints: { 'image.generate': 'https://provider.example/v1/projects/project/locations/region/publishers/google/models/imagen-4.0-generate-001:predict' } },
      params: { prompt: 'draw', sampleCount: 2, aspectRatio: '3:4' },
    }), { fetch: fetcher })
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://provider.example/v1/projects/project/locations/region/publishers/google/models/imagen-4.0-generate-001:predict')
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer vertex-token' })
    expect(requestBody(fetcher)).toEqual({ instances: [{ prompt: 'draw' }], parameters: { sampleCount: 2, aspectRatio: '3:4' } })
    expect(result.parts).toHaveLength(2)
  })

  it('Seedream 多图输入、组图输出与用量全部保留', async () => {
    const fetcher = mockFetch({ data: [{ b64_json: first }, { b64_json: second }], usage: { generated_images: 2 } })
    const result = await executeFileServiceAdapter(input('doubao-seedream', {
      operation: 'image.reference', assets: [asset, { ...asset, assetId: 'b' }],
      connection: { baseUrl: 'https://provider.example/api/v3', model: 'configured-endpoint' },
      params: { prompt: 'draw', sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 2 } },
    }), { fetch: fetcher })
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://provider.example/api/v3/images/generations')
    expect(requestBody(fetcher).image).toEqual([`data:image/png;base64,${asset.data.toString('base64')}`, `data:image/png;base64,${asset.data.toString('base64')}`])
    expect(requestBody(fetcher)).toMatchObject({ response_format: 'b64_json', stream: false })
    expect(result.parts).toHaveLength(2)
    expect(result.usage).toEqual({ generated_images: 2 })
  })

  it('Seedream 5.0 pro 不错误开放组图；流式明确拒绝', async () => {
    const fetcher = mockFetch({})
    const configured = input('doubao-seedream', { connection: { baseUrl: 'https://provider.example', model: 'doubao-seedream-5-0-pro-260628' }, params: { prompt: 'draw', sequential_image_generation: 'auto' } })
    await expect(executeFileServiceAdapter(configured, { fetch: fetcher })).rejects.toMatchObject({ code: 'file_service.invalid_params' })
    await expect(executeFileServiceAdapter({ ...configured, params: { prompt: 'draw', stream: true } }, { fetch: fetcher })).rejects.toMatchObject({ code: 'file_service.invalid_params' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['minimax-images', { prompt: 'draw', n: 10 }, 'image-01'],
    ['minimax-images', { prompt: 'draw', width: 512 }, 'image-01'],
    ['minimax-images', { prompt: 'draw', width: 513, height: 512 }, 'image-01'],
    ['minimax-images', { prompt: 'draw', width: 512, height: 512, aspect_ratio: '1:1' }, 'image-01'],
    ['minimax-images', { prompt: 'draw', style: { style_type: '漫画' } }, 'image-01'],
    ['openai-images', { prompt: 'draw', output_compression: 50 }, 'gpt-image-1'],
    ['openai-images', { prompt: 'draw', output_format: 'jpeg', background: 'transparent' }, 'gpt-image-1'],
    ['openai-responses-image', { prompt: 'draw', partial_images: 2 }, 'manual-model'],
    ['google-gemini-image', { prompt: 'draw', responseModalities: ['TEXT'] }, 'manual-model'],
    ['google-gemini-image', { prompt: 'draw', imageConfig: { imageSize: '4K' } }, 'gemini-2.5-flash-image'],
    ['google-imagen', { prompt: 'draw', sampleCount: 2 }, 'imagen-4.0-ultra-generate-001'],
    ['doubao-seedream', { prompt: 'draw', sequential_image_generation_options: { max_images: 2 } }, 'manual-model'],
    ['openai-images', { prompt: 'draw', arbitraryScript: 'no' }, 'manual-model'],
  ])('严格拒绝不合法参数 %s %j', (adapter, params, model) => {
    expect(() => validateFileServiceAdapterParams(adapter as string, params as Record<string, unknown>, model as string)).toThrow(FileServiceAdapterError)
  })

  it('URL 结果默认拒绝下载，不把生成重试当下载重试', async () => {
    const fetcher = mockFetch({ data: [{ url: 'https://cdn.example/output.png' }] })
    await expect(executeFileServiceAdapter(input('openai-images'), { fetch: fetcher })).rejects.toMatchObject({ code: 'file_operation.delivery_failed' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('下载函数不接收服务凭据，下载读取仍受大小限制', async () => {
    const fetcher = mockFetch({ data: [{ url: 'https://cdn.example/output.png' }] })
    const download = vi.fn().mockResolvedValue(new Response('downloaded fixture', { headers: { 'content-type': 'image/png' } }))
    const result = await executeFileServiceAdapter(input('openai-images'), { fetch: fetcher, download })
    expect(download.mock.calls[0]![1]).toEqual({ signal: expect.any(AbortSignal), maxBytes: MAX_FILE_SERVICE_OUTPUT_BYTES })
    expect(JSON.stringify(download.mock.calls)).not.toContain('secret-value')
    expect(result.parts[0]).toMatchObject({ type: 'file', mimeType: 'image/png', data: Buffer.from('downloaded fixture') })
    download.mockResolvedValueOnce(new Response('small', { headers: { 'content-length': String(MAX_FILE_SERVICE_OUTPUT_BYTES + 1) } }))
    await expect(executeFileServiceAdapter(input('openai-images'), { fetch: fetcher, download })).rejects.toMatchObject({ code: 'asset.too_large' })
  })

  it.each(['http://127.0.0.1/file', 'http://[::1]/file', 'https://localhost/file', 'http://metadata.internal/file', 'file:///etc/passwd', 'https://user:password@cdn.example/file'])('下载拒绝不安全地址 %s', async (url) => {
    const fetcher = mockFetch({ data: [{ url }] })
    const download = vi.fn()
    await expect(executeFileServiceAdapter(input('openai-images'), { fetch: fetcher, download })).rejects.toBeInstanceOf(FileServiceAdapterError)
    expect(download).not.toHaveBeenCalled()
  })

  it('下载实际流量超限时立即取消，即使没有 Content-Length', async () => {
    const fetcher = mockFetch({ data: [{ url: 'https://cdn.example/file' }] })
    const cancel = vi.fn()
    const chunk = new Uint8Array(1024 * 1024)
    let count = 0
    const download = vi.fn().mockImplementation(async () => new Response(new ReadableStream({
      pull(controller) { if (++count <= 102) controller.enqueue(chunk); else controller.close() }, cancel,
    })))
    await expect(executeFileServiceAdapter(input('openai-images'), { fetch: fetcher, download })).rejects.toMatchObject({ code: 'asset.too_large' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('HTTP 错误保留状态与厂商错误码，不自动重试', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { code: 'rate_limit_exceeded', message: 'secret-value' } }, 429))
    await expect(executeFileServiceAdapter(input('openai-images'), { fetch: fetcher })).rejects.toMatchObject({ code: 'file_service.provider_error', providerCode: 'rate_limit_exceeded', httpStatus: 429 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('无效 base64 不产生伪造文件', async () => {
    const fetcher = mockFetch({ data: [{ b64_json: 'not-base64!' }] })
    await expect(executeFileServiceAdapter(input('openai-images'), { fetch: fetcher })).rejects.toMatchObject({ code: 'file_service.invalid_response' })
  })

  it('后续下载失败仍保留前序文字与文件，重解析仅下载缺失项', async () => {
    const fetcher = mockFetch({ data: [{ revised_prompt: '说明', url: 'https://cdn.example/first.png' }, { url: 'https://cdn.example/second.png' }] })
    const download = vi.fn().mockResolvedValueOnce(new Response('first', { headers: { 'content-type': 'image/png' } }))
      .mockRejectedValueOnce(new Error('unavailable'))
    const failure = await executeFileServiceAdapter(input('openai-images'), { fetch: fetcher, download }).catch(error => error as FileServiceAdapterError)
    expect(failure.partialOutput?.parts.map((part: { type: string }) => part.type)).toEqual(['text', 'file'])
    expect(failure.partialOutput?.incomplete).toMatchObject({ retryable: true })
    download.mockResolvedValueOnce(new Response('second', { headers: { 'content-type': 'image/png' } }))
    const recovered = await executeFileServiceAdapter(input('openai-images'), { fetch: fetcher, download, savedParts: failure.partialOutput!.parts })
    expect(download).toHaveBeenCalledTimes(3)
    expect(String(download.mock.calls[2]![0])).toBe('https://cdn.example/second.png')
    expect(recovered.parts.map(part => part.type === 'text' ? part.text : part.data.toString())).toEqual(['说明', 'first', 'second'])
    expect(recovered.incomplete).toBeUndefined()
  })

  it('单项拒绝或过滤不能把多图操作当作完整成功', async () => {
    const fetcher = mockFetch({ data: [{ b64_json: first }, { error: { code: 'blocked', message: 'secret-value' } }] })
    const result = await executeFileServiceAdapter(input('doubao-seedream'), { fetch: fetcher })
    expect(result.parts.map(part => part.type)).toEqual(['file', 'text'])
    expect(result.incomplete).toMatchObject({ retryable: false })
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

  it('固定输出数量不足时标为未完整成功，组图上限不当作必须数量', async () => {
    const fetcher = mockFetch({ data: [{ b64_json: first }, { b64_json: second }] })
    const result = await executeFileServiceAdapter(input('openai-images', { params: { prompt: 'three images', n: 3 } }), { fetch: fetcher })
    expect(result.parts).toHaveLength(2)
    expect(result.incomplete).toMatchObject({ code: 'file_service.output_incomplete', retryable: false })
    const grouped = await executeFileServiceAdapter(input('doubao-seedream', {
      params: { prompt: 'up to three', sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 3 } },
    }), { fetch: fetcher })
    expect(grouped.incomplete).toBeUndefined()
  })

  it('后续无效数据不丢失前面的有效结果，也不建议重新生成', async () => {
    const fetcher = mockFetch({ base_resp: { status_code: 0 }, data: { image_base64: [first, 'invalid'] } })
    await expect(executeFileServiceAdapter(input(), { fetch: fetcher })).rejects.toMatchObject({
      code: 'file_service.invalid_response', partialOutput: { parts: [expect.objectContaining({ type: 'file' })], incomplete: { retryable: false } },
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('取消已发生时不发起外部调用', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = mockFetch({})
    await expect(executeFileServiceAdapter(input('openai-images', { signal: controller.signal }), { fetch: fetcher })).rejects.toMatchObject({ code: 'file_operation.cancelled' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('等待期间取消立即结束，并向传输传递 abort', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined))
    const result = executeFileServiceAdapter(input('openai-images', { signal: controller.signal }), { fetch: fetcher })
    const check = expect(result).rejects.toMatchObject({ code: 'file_operation.cancelled' })
    controller.abort()
    await check
    expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true)
  })

  it('总时限包括传输等待，不重试，也不宣称远端已取消', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined))
    const result = executeFileServiceAdapter(input(), { fetch: fetcher, timeoutMs: 20 })
    const check = expect(result).rejects.toMatchObject({ code: 'file_operation.timeout' })
    await vi.advanceTimersByTimeAsync(20)
    await check
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true)
  })

  it('timeoutMs=0 时不设本地截止，仅响应显式取消或远端完成', async () => {
    vi.useFakeTimers()
    let release!: (value: Response) => void
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { release = resolve }))
    const result = executeFileServiceAdapter(input(), { fetch: fetcher, timeoutMs: 0 })
    let settled = false
    void result.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(32 * 86_400_000)
    expect(settled).toBe(false)
    release(json({ base_resp: { status_code: 0 }, data: { image_base64: [first] } }))
    const resolved = await result
    expect(resolved.parts).toHaveLength(1)
  })
})
