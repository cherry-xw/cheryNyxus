import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDeepseekAdapter } from '@/agent/provider/deepseek.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter, type LLMResponse } from '@/core/message/adapter.js'
import { getSenseAdapter } from '@/core/sense/adapter.js'

const fetchMock = vi.fn()

describe('DeepSeek provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    registerDeepseekAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('注册三层 adapter', () => {
    expect(getLLMAdapter('deepseek')).toBeDefined()
    expect(getMessageAdapter('deepseek')).toBeDefined()
    expect(getSenseAdapter('deepseek')).toBeDefined()
  })

  it('仅为带工具调用的 assistant 回传 reasoning_content', () => {
    const history: LLMResponse[] = [
      { id: 'plain', role: 'assistant', content: '普通回复', thinking: '无需拼接', createdAt: 0, updateAt: 0 },
      {
        id: 'tool',
        role: 'assistant',
        content: '调用工具',
        thinking: '必须保留',
        senseCalls: [{ id: 'call-1', name: 'weather', arguments: '{}' }],
        createdAt: 0,
        updateAt: 0,
      },
      { id: 'result', role: 'sense', content: '晴天', createdAt: 0, updateAt: 0 },
      { id: 'user', role: 'user', content: '继续', createdAt: 0, updateAt: 0 },
    ]

    const messages = getMessageAdapter('deepseek')!.buildMessages(history) as Array<{
      role: string
      reasoning_content?: string
      tool_calls?: unknown[]
    }>

    expect(messages[0]).not.toHaveProperty('reasoning_content')
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      reasoning_content: '必须保留',
      tool_calls: [{ id: 'call-1' }],
    })
  })

  it.each([
    ['enabled 片段', { thinking: { type: 'enabled' } }],
    ['disabled 片段', { thinking: { type: 'disabled' } }],
    ['enabled + effort 片段', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
  ] as const)('thinkingParams %s 直传 spread 进请求 body', async (_name, thinkingParams) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await getLLMAdapter('deepseek')!.chat([], [], {
      model: 'deepseek-v4-pro',
      url: 'https://api.deepseek.com',
      key: 'test-key',
      thinkingParams,
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject(thinkingParams)
  })

  it('不传 thinkingParams 时 body 不含 thinking / reasoning_effort 键', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await getLLMAdapter('deepseek')!.chat([], [], {
      model: 'deepseek-v4-pro',
      url: 'https://api.deepseek.com',
      key: 'test-key',
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})
