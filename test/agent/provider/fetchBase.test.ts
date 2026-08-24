import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEndpointUrl, jsonRequest, streamSSE } from '@/agent/provider/fetchBase.js'
import { ClassifiedError } from '@/utils/error.js'

/**
 * fetchBase 的 URL 自动补全与流完整性校验（docs/agent/provider.md）：
 * - buildEndpointUrl：无路径补版本段、已有路径只拼 endpoint、fullUrl 原样返回
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
  it('无路径 → 补版本段 + endpoint（旧配置兼容）', () => {
    expect(buildEndpointUrl('https://gw:11411', { endpoint: '/chat/completions' })).toBe(
      'https://gw:11411/v1/chat/completions',
    )
  })

  it('已含 /v1 → 只拼 endpoint（不重复补）', () => {
    expect(buildEndpointUrl('https://gw:11411/v1', { endpoint: '/chat/completions' })).toBe(
      'https://gw:11411/v1/chat/completions',
    )
  })

  it('自定义路径 → 只拼 endpoint（尊重用户输入）', () => {
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
      'https://gw:11411/v1/chat/completions',
    )
  })

  it('endpoint 空串 → 仅补版本段（openai SDK baseURL 场景）', () => {
    expect(buildEndpointUrl('https://api.openai.com', { endpoint: '' })).toBe(
      'https://api.openai.com/v1',
    )
    expect(buildEndpointUrl('https://api.openai.com/v1', { endpoint: '' })).toBe(
      'https://api.openai.com/v1',
    )
  })

  it('自定义版本段 versionPath', () => {
    expect(
      buildEndpointUrl('https://gw', { versionPath: '/v4', endpoint: '/messages' }),
    ).toBe('https://gw/v4/messages')
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

  it('正常 JSON 响应 → 返回解析对象（url 无路径自动补 /v1）', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const result = await jsonRequest('https://gw:11411', { q: 1 }, 'k')
    expect(result).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gw:11411/v1/chat/completions',
      expect.anything(),
    )
  })
})
