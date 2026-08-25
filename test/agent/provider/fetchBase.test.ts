import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEndpointUrl, jsonRequest, resolveProviderUrl, streamSSE } from '@/agent/provider/fetchBase.js'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern.js'
import { ClassifiedError } from '@/utils/error.js'

/**
 * fetchBase 的 URL 端点拼接与流完整性校验（docs/agent/provider.md）：
 * - buildEndpointUrl：base + endpoint（版本段由用户填写，不自动补 /v1）、fullUrl 原样返回
 * - streamSSE/jsonRequest：伪 200（非事件流/JSON，如网关 SPA 回退）→ validation；
 *   空流（0 有效事件）→ provider。
 */

const fetchMock = vi.fn()

function sseResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  )
}

function asClassified(err: unknown): ClassifiedError {
  expect(err).toBeInstanceOf(ClassifiedError)
  return err as ClassifiedError
}

describe('buildEndpointUrl', () => {
  it('无版本段 → base + endpoint（版本段由用户填写，不自动补 /v1）', () => {
    expect(buildEndpointUrl('https://gw:11411', { endpoint: '/chat/completions' })).toBe(
      'https://gw:11411/chat/completions',
    )
  })

  it('已含 /v1 → base + endpoint（不重复补）', () => {
    expect(buildEndpointUrl('https://gw:11411/v1', { endpoint: '/chat/completions' })).toBe(
      'https://gw:11411/v1/chat/completions',
    )
  })

  it('自定义路径 → base + endpoint（尊重用户输入）', () => {
    expect(buildEndpointUrl('https://gw/api', { endpoint: '/chat/completions' })).toBe(
      'https://gw/api/chat/completions',
    )
  })

  it('fullUrl=true → URL 原样返回，不拼接任何字符串', () => {
    expect(
      buildEndpointUrl('https://gw:11411', { fullUrl: true, endpoint: '/chat/completions' }),
    ).toBe('https://gw:11411')
    expect(
      buildEndpointUrl('https://gw:11411/v1/chat/completions', {
        fullUrl: true,
        endpoint: '/chat/completions',
      }),
    ).toBe('https://gw:11411/v1/chat/completions')
  })

  it('末尾斜杠归一', () => {
    expect(buildEndpointUrl('https://gw:11411/', { endpoint: '/chat/completions' })).toBe(
      'https://gw:11411/chat/completions',
    )
  })

  it('endpoint 空串 → base 原样（openai SDK baseURL 场景：SDK 自拼端点，版本段用户填写）', () => {
    expect(buildEndpointUrl('https://api.openai.com', { endpoint: '' })).toBe(
      'https://api.openai.com',
    )
    expect(buildEndpointUrl('https://api.openai.com/v1', { endpoint: '' })).toBe(
      'https://api.openai.com/v1',
    )
  })
})

describe('resolveProviderUrl 统一入口', () => {
  // 各 provider 的注册在 register*Adapter() 时生效；这里直接 register 模拟能力声明，
  // 验证「注册能力 → 解析」链路与两分支行为（与正式 chat / utils.models / testConnection 同规则）。
  beforeEach(() => {
    registerProviderUrlPattern('openai', { chatEndpoint: '', modelsEndpoint: '' })
    registerProviderUrlPattern('anthropic', {
      chatEndpoint: '/messages',
      modelsEndpoint: '/models?limit=1000',
    })
    registerProviderUrlPattern('bigmodel', { chatEndpoint: '/chat/completions' })
    registerProviderUrlPattern('deepseek', {
      chatEndpoint: '/chat/completions',
      modelsEndpoint: '',
    })
  })

  it('未注册 provider → host 模式原样（仅去尾斜杠）', () => {
    expect(resolveProviderUrl('ollama', 'http://localhost:11434', { kind: 'chat' })).toBe(
      'http://localhost:11434',
    )
    expect(resolveProviderUrl('ollama', 'http://localhost:11434/', { kind: 'models' })).toBe(
      'http://localhost:11434',
    )
  })

  it('openai：chat/models 端点由 SDK 拼，base 原样（版本段用户填写，不补 /v1）', () => {
    expect(resolveProviderUrl('openai', 'https://api.openai.com', { kind: 'chat' })).toBe(
      'https://api.openai.com',
    )
    expect(resolveProviderUrl('openai', 'https://api.openai.com/v1', { kind: 'chat' })).toBe(
      'https://api.openai.com/v1',
    )
    expect(resolveProviderUrl('openai', 'https://api.openai.com/v1', { kind: 'models' })).toBe(
      'https://api.openai.com/v1',
    )
  })

  it('anthropic：base + endpoint（版本段用户填写，不补 /v1）', () => {
    expect(resolveProviderUrl('anthropic', 'https://api.anthropic.com', { kind: 'chat' })).toBe(
      'https://api.anthropic.com/messages',
    )
    expect(resolveProviderUrl('anthropic', 'https://api.anthropic.com', { kind: 'models' })).toBe(
      'https://api.anthropic.com/models?limit=1000',
    )
    expect(resolveProviderUrl('anthropic', 'https://api.anthropic.com/v1', { kind: 'chat' })).toBe(
      'https://api.anthropic.com/v1/messages',
    )
  })

  it('fullUrl=true → URL 原样（仅去尾斜杠），不补任何东西', () => {
    expect(resolveProviderUrl('anthropic', 'https://gw:11411', { fullUrl: true, kind: 'chat' })).toBe(
      'https://gw:11411',
    )
    expect(
      resolveProviderUrl('openai', 'https://api.openai.com/v1/chat/completions', {
        fullUrl: true,
        kind: 'chat',
      }),
    ).toBe('https://api.openai.com/v1/chat/completions')
    expect(
      resolveProviderUrl('openai', 'https://api.openai.com/v1/', { fullUrl: true, kind: 'models' }),
    ).toBe('https://api.openai.com/v1')
  })

  it('一致性锁：bigmodel/deepseek chat 与 buildEndpointUrl 协议常量一致（防 jsonRequest 漂移）', () => {
    for (const url of [
      'https://gw:11411',
      'https://gw:11411/',
      'https://gw:11411/v1',
      'https://gw:11411/api',
    ]) {
      expect(resolveProviderUrl('bigmodel', url, { kind: 'chat' })).toBe(
        buildEndpointUrl(url, { endpoint: '/chat/completions' }),
      )
      expect(resolveProviderUrl('deepseek', url, { kind: 'chat' })).toBe(
        buildEndpointUrl(url, { endpoint: '/chat/completions' }),
      )
    }
  })

  it('bigmodel models 未声明 → host 模式原样（utils.models 对该 provider 报「不支持」）', () => {
    expect(resolveProviderUrl('bigmodel', 'https://gw:11411', { kind: 'models' })).toBe(
      'https://gw:11411',
    )
  })
})

describe('streamSSE 流完整性校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('伪 200（text/html 网关 SPA 回退）→ validation 配置错误', async () => {
    fetchMock.mockResolvedValue(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const stream = streamSSE('https://gw:11411', { q: 1 }, 'k')
    await expect(stream.next()).rejects.toSatisfy((err: unknown) => {
      const e = asClassified(err)
      expect(e.category).toBe('validation')
      expect(e.userMessage).toContain('大脑配置可能有误')
      return true
    })
  })

  it('空流（event-stream 0 事件即关闭）→ provider 空流错误', async () => {
    fetchMock.mockResolvedValue(sseResponse([]))
    const stream = streamSSE('https://gw:11411/v1', { q: 1 }, 'k')
    await expect(stream.next()).rejects.toSatisfy((err: unknown) => {
      const e = asClassified(err)
      expect(e.category).toBe('provider')
      expect(e.userMessage).toContain('响应流为空')
      return true
    })
  })

  it('[DONE] 前无数据事件 → provider 空流错误', async () => {
    fetchMock.mockResolvedValue(sseResponse([': keep-alive\n\n', 'data: [DONE]\n\n']))
    const stream = streamSSE('https://gw:11411/v1', { q: 1 }, 'k')
    await expect(stream.next()).rejects.toSatisfy((err: unknown) => {
      const e = asClassified(err)
      expect(e.category).toBe('provider')
      return true
    })
  })

  it('正常事件流 → yield 解析后 JSON 并在 [DONE] 结束', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"delta":"你"}\n\n', 'data: {"delta":"好"}\n\n', 'data: [DONE]\n\n']),
    )
    const events: unknown[] = []
    for await (const ev of streamSSE('https://gw:11411/v1', { q: 1 }, 'k')) events.push(ev)
    expect(events).toEqual([{ delta: '你' }, { delta: '好' }])
  })
})

describe('jsonRequest 流完整性校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('content-type 非 JSON（网关 SPA 回退）→ validation 配置错误', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    await expect(jsonRequest('https://gw:11411', { q: 1 }, 'k')).rejects.toSatisfy(
      (err: unknown) => {
        const e = asClassified(err)
        expect(e.category).toBe('validation')
        expect(e.userMessage).toContain('大脑配置可能有误')
        return true
      },
    )
  })

  it('声明 JSON 但响应体非法 → validation 配置错误', async () => {
    fetchMock.mockResolvedValue(
      new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    await expect(jsonRequest('https://gw:11411/v1', { q: 1 }, 'k')).rejects.toSatisfy(
      (err: unknown) => {
        const e = asClassified(err)
        expect(e.category).toBe('validation')
        return true
      },
    )
  })

  it.each([
    ['无版本段 → base + endpoint（不补 /v1）', 'https://gw:11411', 'https://gw:11411/chat/completions'],
    ['含 /v1 → base + endpoint', 'https://gw:11411/v1', 'https://gw:11411/v1/chat/completions'],
  ])('正常 JSON 响应 → 返回解析对象（%s）', async (_label, inputUrl, expected) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const result = await jsonRequest(inputUrl, { q: 1 }, 'k')
    expect(result).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledWith(expected, expect.anything())
  })
})
