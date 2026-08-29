import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleUtilsModels } from '@/service/utils/handler.js'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import type { HandlerContext } from '@/service/message/router.js'

/**
 * utils.models anthropic 双尝试（docs/agent/provider.md「anthropic 模型列表双尝试」）：
 * 主尝试 Anthropic 原生 GET {url}/models?limit=1000（x-api-key + anthropic-version）；
 * 无产出且未勾选 fullUrl → 回退 OpenAI 兼容 GET {url}/models（仅 Bearer）；
 * 两边均无产出 → error 聚合两段原因。
 */
const fetchMock = vi.fn()
const ctx = {} as HandlerContext

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('utils.models anthropic 双尝试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    // 注册 anthropic URL pattern（/messages、/models?limit=1000）——与 anthropic.test.ts 同款前提
    registerAnthropicAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('主尝试成功：直接返回，不做回退', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'anthropic',
      url: 'https://api.anthropic.com/v1',
      key: 'sk-ant-test',
    })
    expect(res.models).toEqual([{ id: 'claude-x', name: 'Claude X' }])
    expect(fetchMock).toHaveBeenCalledOnce()
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-ant-test' })
  })

  it('主尝试 401 → 回退 OpenAI 兼容 Bearer 命中', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('limit=1000')
        ? jsonResponse({ error: 'auth' }, 401)
        : jsonResponse({ data: [{ id: 'MiniMax-M2.7', owned_by: 'minimax' }] }),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'anthropic',
      url: 'https://gw.example.com/v1',
      key: 'test-key',
    })
    expect(res.error).toBeUndefined()
    expect(res.models).toEqual([
      { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', ownedBy: 'minimax' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [fallbackUrl, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(fallbackUrl).toBe('https://gw.example.com/v1/models')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('主尝试 200 但空列表 → 回退命中', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('limit=1000')
        ? jsonResponse({ data: [] })
        : jsonResponse({ data: [{ id: 'm1' }] }),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'anthropic',
      url: 'https://gw.example.com/v1',
      key: 'test-key',
    })
    expect(res.models).toEqual([{ id: 'm1', name: 'm1', ownedBy: undefined }])
  })

  it('两边均无产出 → error 聚合两段原因', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('limit=1000') ? jsonResponse('not found', 404) : jsonResponse('denied', 401),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'anthropic',
      url: 'https://gw.example.com/v1',
      key: 'test-key',
    })
    expect(res.models).toEqual([])
    expect(res.error).toContain('Anthropic 接口返回 404')
    expect(res.error).toContain('OpenAI 兼容回退（GET /models + Bearer）亦失败')
    expect(res.error).toContain('接口返回 401')
  })

  it('fullUrl=true：主尝试失败也不回退（完全自负责）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'auth' }, 401))
    const res = await handleUtilsModels(ctx, {
      provider: 'anthropic',
      url: 'https://gw.example.com/v1/models',
      key: 'test-key',
      fullUrl: true,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(res.models).toEqual([])
    expect(res.error).toContain('Anthropic 接口返回 401')
  })

  it('密钥占位符未替换 → 直接短路，不发请求', async () => {
    const res = await handleUtilsModels(ctx, {
      provider: 'anthropic',
      url: 'https://api.anthropic.com/v1',
      key: '$MINIMAX_KEY',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.models).toEqual([])
    expect(res.error).toContain('$MINIMAX_KEY 未替换')
  })
})

describe('utils.models openai SDK 路径空列表提示', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('SDK 返回空列表 → error 提示补版本段（伪 200 与真空列表不可区分）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }))
    const res = await handleUtilsModels(ctx, {
      provider: 'openai',
      url: 'https://gw.example.com',
      key: 'sk-test',
    })
    expect(res.models).toEqual([])
    expect(res.error).toContain('未获取到任何模型')
    expect(res.error).toContain('/v1')
  })

  it('SDK 返回非空列表 → 正常返回，无提示', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o', owned_by: 'system' }] }))
    const res = await handleUtilsModels(ctx, {
      provider: 'openai',
      url: 'https://api.openai.com/v1',
      key: 'sk-test',
    })
    expect(res.error).toBeUndefined()
    expect(res.models).toEqual([{ id: 'gpt-4o', name: 'gpt-4o', ownedBy: 'system' }])
  })
})
