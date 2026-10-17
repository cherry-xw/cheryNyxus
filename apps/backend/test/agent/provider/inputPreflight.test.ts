import { afterEach, describe, expect, it, vi } from 'vitest'
import { preflightModelInput } from '@/agent/provider/inputPreflight.js'
import type { LLMOptions } from '@/core/llm/adapter.js'

afterEach(() => vi.unstubAllGlobals())
const setup = (contextLimit = 100000) => {
  const report = vi.fn()
  const options: LLMOptions = { model: 'test-model', url: 'https://api.example/v1', key: 'secret', inputPreflight: { report, contextLimit } }
  return { report, options }
}

describe('模型输入 token 预检', () => {
  it('最小检查：Anthropic 只发送实际输入和工具，不触发生成', async () => {
    const { options, report } = setup()
    const fetch = vi.fn().mockResolvedValue(Response.json({ input_tokens: 321 }))
    vi.stubGlobal('fetch', fetch)
    const body = { model: options.model, system: 'system', messages: [{ role: 'user', content: 'question' }], tools: [{ name: 'tool' }], max_tokens: 1000, stream: true }
    await preflightModelInput(body, options, 'anthropic')
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.example/v1/messages/count_tokens')
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ model: body.model, system: body.system, messages: body.messages, tools: body.tools })
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ tokenSource: 'official-preflight', inputTokens: 321, officialPreflight: 'succeeded' }))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('Responses 沿完整端点预检，官方明确超限则阻止发送', async () => {
    const { options, report } = setup(10)
    options.url = 'https://api.example/v1/responses'; options.fullUrl = true
    const fetch = vi.fn().mockResolvedValue(Response.json({ input_tokens: 11 }))
    vi.stubGlobal('fetch', fetch)
    await expect(preflightModelInput({ model: 'test', input: 'question' }, options, 'openai-responses')).rejects.toThrow('上下文')
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.example/v1/responses/input_tokens')
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 11 }))
  })

  it('接口不可用时保守估算文字，二进制与媒体 token 不冒报为零', async () => {
    const { options, report } = setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await preflightModelInput({ model: 'test', input: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'a'.repeat(100000) }, { type: 'input_text', text: '用户问题' }] }, options, 'openai-responses')
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ tokenSource: 'conservative-local-estimate', officialPreflight: 'unavailable', mediaTokens: null }))
    expect(report.mock.calls[0]![0].estimatedTextTokens).toBeLessThan(1000)
    expect(report.mock.calls[0]![0].inputTokens).toBeUndefined()
  })

  it('取消必须传播，不能当成预检不可用后继续发生成请求', async () => {
    const { options } = setup()
    const controller = new AbortController()
    options.signal = controller.signal
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => { controller.abort(new Error('cancelled')); throw controller.signal.reason }))
    await expect(preflightModelInput({ model: 'test', messages: [] }, options, 'anthropic')).rejects.toThrow('cancelled')
  })

  it('未识别的完整端点不猜地址，也不发送预检请求', async () => {
    const { options, report } = setup()
    options.url = 'https://api.example/custom'; options.fullUrl = true
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await preflightModelInput({ model: 'test', messages: [] }, options, 'anthropic')
    expect(fetch).not.toHaveBeenCalled()
    expect(report.mock.calls[0]![0].officialPreflight).toBe('unsupported')
  })
})
