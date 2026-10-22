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
  it('同一最终请求快照驱动整理决定并扣除实际输出预留', async () => {
    const { options, report } = setup(1000)
    options.inputPreflight = { ...options.inputPreflight!, compactIfNeeded: true, safetyMargin: 100, trigger: { unit: 'percent', value: 0.8 } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ input_tokens: 750 })))
    await expect(preflightModelInput({ model: 'test', input: 'question', max_output_tokens: 200 }, options, 'openai-responses')).rejects.toMatchObject({ name: 'ModelInputNeedsCompaction' })
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 750, outputReserve: 200, safetyMargin: 100, effectiveCeiling: 700, projectionId: expect.any(String) }))
  })
  it('整理后的最终请求仍超预算时不提交候选摘要', async () => {
    const { options } = setup(1000)
    const accepted = vi.fn()
    options.inputPreflight = { ...options.inputPreflight!, afterCompaction: true, safetyMargin: 100, accepted }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ input_tokens: 750 })))
    await expect(preflightModelInput({ model: 'test', input: 'question', max_output_tokens: 200 }, options, 'openai-responses')).rejects.toThrow('budget')
    expect(accepted).not.toHaveBeenCalled()
  })
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

  it.each(['openai', 'openai-responses', 'anthropic'])('本地字节上界不能冒充官方超限：%s', async protocol => {
    const { options, report } = setup(128000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const body = { model: 'test', messages: [{ role: 'user', content: '中'.repeat(45000) }] }
    await expect(preflightModelInput(body, options, protocol)).resolves.toBeUndefined()
    expect(report.mock.calls[0]![0].estimatedTextTokens).toBeLessThan(128000)
    expect(report.mock.calls[0]![0].estimatedTextTokens).toBeGreaterThan(45000)
    expect(report.mock.calls[0]![0].inputTokens).toBeUndefined()
  })

  it('字节大小保护仍然阻止超过32MiB的请求', async () => {
    const { options, report } = setup()
    await expect(preflightModelInput({ input: 'a'.repeat(32 * 1024 * 1024) }, options, 'openai')).rejects.toThrow('32 MiB')
    expect(report).not.toHaveBeenCalled()
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
