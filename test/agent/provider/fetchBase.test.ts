/**
 * fetchBase 单元测试：brainHttpError / brainNetworkError / classifyBrainError /
 * wrapBrainStream / assertChatOptions / jsonRequest / streamSSE。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  brainHttpError,
  brainNetworkError,
  classifyBrainError,
  wrapBrainStream,
  assertChatOptions,
  jsonRequest,
  streamSSE,
} from '@/agent/provider/fetchBase.js'
import { ClassifiedError } from '@/utils/error.js'

// ========== brainHttpError ==========
describe('brainHttpError', () => {
  it('401 → auth', () => {
    const e = brainHttpError(401, 'bad key')
    expect(e).toBeInstanceOf(ClassifiedError)
    expect(e.category).toBe('auth')
    expect(e.userMessage).toContain('钥匙不对')
  })

  it('403 → auth', () => {
    const e = brainHttpError(403, 'forbidden')
    expect(e.category).toBe('auth')
  })

  it('429 → provider', () => {
    const e = brainHttpError(429, 'rate limited')
    expect(e.category).toBe('provider')
    expect(e.userMessage).toContain('忙不过来')
  })

  it('500 → provider', () => {
    const e = brainHttpError(500, 'internal error')
    expect(e.category).toBe('provider')
    expect(e.userMessage).toContain('出了点状况')
  })

  it('502 → provider', () => {
    const e = brainHttpError(502, 'bad gateway')
    expect(e.category).toBe('provider')
  })

  it('418 → unknown (其他非 2xx)', () => {
    const e = brainHttpError(418, 'teapot')
    expect(e.category).toBe('unknown')
    expect(e.userMessage).toContain('不太对')
  })

  it('message 含 upstream status + logMessage', () => {
    const e = brainHttpError(500, 'oops')
    expect(e.message).toContain('upstream 500')
    expect(e.message).toContain('oops')
  })

  it('source = brain', () => {
    expect(brainHttpError(500, 'x').source).toBe('brain')
  })
})

// ========== brainNetworkError ==========
describe('brainNetworkError', () => {
  it('category = network', () => {
    const e = brainNetworkError('ECONNREFUSED', new Error('conn'))
    expect(e.category).toBe('network')
    expect(e.userMessage).toContain('连不上')
  })

  it('source = brain', () => {
    expect(brainNetworkError('x', undefined).source).toBe('brain')
  })

  it('cause 透传', () => {
    const cause = new Error('original')
    expect(brainNetworkError('x', cause).cause).toBe(cause)
  })
})

// ========== classifyBrainError ==========
describe('classifyBrainError', () => {
  it('有 status → brainHttpError', () => {
    const e = classifyBrainError({ status: 401, message: 'bad' })
    expect(e.category).toBe('auth')
  })

  it('Error 有 status → brainHttpError', () => {
    const err = new Error('unauthorized')
    ;(err as any).status = 403
    const e = classifyBrainError(err)
    expect(e.category).toBe('auth')
  })

  it('无 status → classifyError 关键词兜底', () => {
    const e = classifyBrainError(new Error('network connection failed'))
    expect(e.category).toBe('network')
  })

  it('无 status timeout → timeout', () => {
    const e = classifyBrainError(new Error('request timeout'))
    expect(e.category).toBe('timeout')
  })

  it('非 Error 对象 → String 化', () => {
    const e = classifyBrainError('plain string')
    expect(e.message).toBe('plain string')
  })
})

// ========== wrapBrainStream ==========
describe('wrapBrainStream', () => {
  it('正常迭代透传', async () => {
    async function* src() {
      yield 1
      yield 2
    }
    const out: number[] = []
    for await (const v of wrapBrainStream(src())) {
      out.push(v as number)
    }
    expect(out).toEqual([1, 2])
  })

  it('迭代中抛错 → classifyBrainError', async () => {
    async function* src() {
      yield 1
      throw { status: 429, message: 'rate limited' }
    }
    const gen = wrapBrainStream(src())
    await gen.next() // skip first
    await expect(gen.next()).rejects.toBeInstanceOf(ClassifiedError)
  })
})

// ========== assertChatOptions ==========
describe('assertChatOptions', () => {
  it('合法 → 返回 { model, url, key }', () => {
    const r = assertChatOptions({ model: 'gpt-4', url: 'https://api', key: 'sk-123' })
    expect(r).toEqual({ model: 'gpt-4', url: 'https://api', key: 'sk-123' })
  })

  it('缺 model → throw', () => {
    expect(() => assertChatOptions({ url: 'https://api', key: 'k' })).toThrow('大脑没配好')
  })

  it('缺 url → throw', () => {
    expect(() => assertChatOptions({ model: 'gpt-4', key: 'k' })).toThrow('大脑没配好')
  })

  it('缺 model+url → throw', () => {
    expect(() => assertChatOptions({ key: 'k' })).toThrow('大脑没配好')
  })

  it('key 为 $ENV 占位符 → throw', () => {
    expect(() =>
      assertChatOptions({ model: 'gpt-4', url: 'https://api', key: '$API_KEY' }),
    ).toThrow('钥匙没配好')
  })

  it('key 为空 → throw', () => {
    expect(() => assertChatOptions({ model: 'gpt-4', url: 'https://api', key: '' })).toThrow(
      '钥匙没配好',
    )
  })

  it('undefined options → throw', () => {
    expect(() => assertChatOptions(undefined)).toThrow('大脑没配好')
  })
})

// ========== jsonRequest ==========
describe('jsonRequest', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  it('成功 → 返回 JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
    })
    const r = await jsonRequest('https://api', { model: 'gpt-4' }, 'sk-123')
    expect(r.choices).toEqual([])
  })

  it('网络错误 → brainNetworkError', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(jsonRequest('https://api', {}, 'k')).rejects.toBeInstanceOf(ClassifiedError)
  })

  it('非 2xx → brainHttpError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: () => Promise.resolve('rate limited'),
    })
    await expect(jsonRequest('https://api', {}, 'k')).rejects.toThrow()
    try {
      await jsonRequest('https://api', {}, 'k')
    } catch (e) {
      expect((e as ClassifiedError).category).toBe('provider')
    }
  })
})

// ========== streamSSE ==========
describe('streamSSE', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  /** 构造 mock SSE ReadableStream */
  function mockSSEStream(lines: string[]) {
    const encoder = new TextEncoder()
    const chunks = lines.map((l) => encoder.encode(l + '\n'))
    let i = 0
    return {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) return { done: false, value: chunks[i++] }
            return { done: true, value: undefined }
          },
          cancel: vi.fn().mockResolvedValue(undefined),
        }
      },
    }
  }

  it('父取消信号会中止正在等待的 fetch', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    globalThis.fetch = vi.fn((_url, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        requestSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })

    const gen = streamSSE('https://api', {}, 'k', controller.signal)
    const pending = gen.next()
    controller.abort()

    await expect(pending).rejects.toBeInstanceOf(ClassifiedError)
    expect(requestSignal?.aborted).toBe(true)
  })

  it('yield 解析后的 JSON 事件', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockSSEStream(['data: {"id":"1"}', 'data: {"id":"2"}', 'data: [DONE]']),
    })
    const out: Record<string, unknown>[] = []
    for await (const chunk of streamSSE('https://api', {}, 'k')) {
      out.push(chunk)
    }
    expect(out).toEqual([{ id: '1' }, { id: '2' }])
  })

  it('跳过空行和注释行', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockSSEStream([': keep-alive', '', 'data: {"ok":true}', '', 'data: [DONE]']),
    })
    const out: Record<string, unknown>[] = []
    for await (const chunk of streamSSE('https://api', {}, 'k')) {
      out.push(chunk)
    }
    expect(out).toEqual([{ ok: true }])
  })

  it('跳过无效 JSON 行', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockSSEStream(['data: {bad json}', 'data: {"ok":true}', 'data: [DONE]']),
    })
    const out: Record<string, unknown>[] = []
    for await (const chunk of streamSSE('https://api', {}, 'k')) {
      out.push(chunk)
    }
    expect(out).toEqual([{ ok: true }])
  })

  it('网络错误 → brainNetworkError', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const gen = streamSSE('https://api', {}, 'k')
    await expect(gen.next()).rejects.toBeInstanceOf(ClassifiedError)
  })

  it('非 2xx → brainHttpError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('bad key'),
    })
    const gen = streamSSE('https://api', {}, 'k')
    await expect(gen.next()).rejects.toThrow()
  })

  it('无 body → brainHttpError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      text: () => Promise.resolve(''),
    })
    const gen = streamSSE('https://api', {}, 'k')
    await expect(gen.next()).rejects.toThrow()
  })
})
