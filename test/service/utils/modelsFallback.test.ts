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
    expect(res.models).toEqual([{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', ownedBy: 'minimax' }])
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
    expect(res.error).toContain('实际请求地址：https://gw.example.com/models')
  })

  it('地址已包含 /models 且 fullUrl=false → 原样请求，不重复拼接端点', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'zhimou-model' }] }))
    const res = await handleUtilsModels(ctx, {
      provider: 'openai',
      url: 'http://zhimoupre.gildata.com:8882/v1/models',
      key: 'resolved-api-key',
    })

    expect(res.error).toBeUndefined()
    expect(res.models).toEqual([{ id: 'zhimou-model', name: 'zhimou-model', ownedBy: undefined }])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://zhimoupre.gildata.com:8882/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer resolved-api-key' },
      }),
    )
  })

  it('SDK 收到 200 错误对象 → 同时返回原始错误与空列表排查建议', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        error: {
          message: '分组 智眸 已被弃用 (request id: 202609040608370991724578268d9d6XpdAVxH3)',
        },
      }),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'openai',
      url: 'https://gw.example.com/v1',
      key: 'sk-test',
    })
    expect(res.models).toEqual([])
    expect(res.error).toContain(
      '请求发生错误: 分组 智眸 已被弃用 (request id: 202609040608370991724578268d9d6XpdAVxH3)',
    )
    expect(res.error).toContain('排查建议：未获取到任何模型')
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

  it('成功响应带顶层 message 字段 → 不误报错误，正常返回列表', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ object: 'list', data: [{ id: 'm1' }], message: 'ok' }),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'openai',
      url: 'https://api.openai.com/v1',
      key: 'sk-test',
    })
    expect(res.error).toBeUndefined()
    expect(res.models).toEqual([{ id: 'm1', name: 'm1', ownedBy: undefined }])
  })
})

describe('utils.models 错误透传（猜测说明 + 原始错误）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('openai fullUrl 非 2xx → 猜测说明 + 接口状态 + 响应体片段（换行压平）', async () => {
    // 响应体含换行：验证外层 catch 拼装前压平（docs/agent/provider.md「utils.models 错误透传」）
    fetchMock.mockResolvedValue(
      new Response('{\n  "error": {\n    "message": "Incorrect API key"\n  }\n}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'openai',
      url: 'https://gw.example.com/v1/chat/completions',
      key: 'sk-test',
      fullUrl: true,
    })
    expect(res.models).toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(res.error).toContain('大脑的钥匙不对')
    expect(res.error).toContain('原始错误')
    expect(res.error).toContain('接口返回 401')
    expect(res.error).toContain('Incorrect API key')
    expect(res.error).not.toContain('\n')
  })

  it('openai SDK 路径非 2xx → 猜测说明 + SDK 原始错误（status + 上游 message）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'Incorrect API key provided' } }, 401),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'openai',
      url: 'https://api.openai.com/v1',
      key: 'sk-bad',
    })
    expect(res.models).toEqual([])
    expect(res.error).toContain('大脑的钥匙不对')
    expect(res.error).toContain('原始错误：401 Incorrect API key provided')
  })
})

describe('utils.models DeepSeek Anthropic 协议', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    registerAnthropicAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('模型列表使用官方根地址 /models，而不是 /anthropic/models', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: 'deepseek-v4-pro', owned_by: 'deepseek' }] }),
    )
    const res = await handleUtilsModels(ctx, {
      provider: 'deepseek',
      protocol: 'anthropic-messages',
      url: 'https://api.deepseek.com/anthropic',
      key: 'sk-test',
    })

    expect(res.models).toEqual([
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', ownedBy: 'deepseek' },
    ])
    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/models', expect.anything())
  })
})
