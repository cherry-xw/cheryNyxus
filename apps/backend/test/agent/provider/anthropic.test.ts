import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter, type LLMResponse } from '@/core/message/adapter.js'
import { ThinkingBlockAssembler } from '@/agent/provider/thinkingBlockAssembler.js'
import { ClassifiedError } from '@/utils/error.js'
import { ErrorId } from '@chery/protocol'

const { mockDispatch } = vi.hoisted(() => ({
  mockDispatch: vi.fn(async () => undefined),
}))

vi.mock('@/agent/hooks/dispatch.js', () => ({ dispatch: mockDispatch }))

const fetchMock = vi.fn()
const options = {
  model: 'claude-test',
  // 新语义：版本段（/v1）由用户填写，后端只拼端点
  url: 'https://api.anthropic.com/v1',
  key: 'test-key',
} as const

function buildProbeMessages(): unknown[] {
  const message: LLMResponse = {
    id: 'probe',
    role: 'user',
    content: '只回复 OK',
    createdAt: 0,
    updateAt: 0,
  }
  return getMessageAdapter('anthropic')!.buildMessages([message])
}

describe('Anthropic Provider Hook 控制', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    registerAnthropicAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('正式 chat 默认执行 PreLLMRequest Hook', async () => {
    const llm = getLLMAdapter('anthropic')!
    await llm.chat(buildProbeMessages(), [], options)

    expect(mockDispatch).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('连接测试可跳过 Hook 但仍发送 Provider 请求', async () => {
    const llm = getLLMAdapter('anthropic')!
    await llm.chat(buildProbeMessages(), [], { ...options, skipHooks: true })

    expect(mockDispatch).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('DeepSeek thinking 与 output_config 字段原样进入 Anthropic 请求体', async () => {
    const llm = getLLMAdapter('anthropic')!
    await llm.chat(buildProbeMessages(), [], {
      ...options,
      model: 'deepseek-v4-pro',
      url: 'https://api.deepseek.com/anthropic',
      skipHooks: true,
      thinkingParams: {
        thinking: { type: 'enabled' },
        output_config: { effort: 'max' },
      },
    })

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe('https://api.deepseek.com/anthropic/messages')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled' },
      output_config: { effort: 'max' },
    })
  })
})

describe('Anthropic Provider URL 解析与流完整性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    registerAnthropicAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 消费 chatStream（skipHooks 直连 fetch）；返回事件列表或抛 ClassifiedError */
  async function consumeChatStream(url: string, fullUrl?: boolean): Promise<unknown[]> {
    const llm = getLLMAdapter('anthropic')!
    const stream = await llm.chatStream(buildProbeMessages() as never, [], {
      ...options,
      url,
      ...(fullUrl !== undefined ? { fullUrl } : {}),
      skipHooks: true,
    })
    const events: unknown[] = []
    for await (const ev of stream) events.push(ev)
    return events
  }

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

  it('流式 url 无版本段 → base + /messages（版本段用户填写，不补 /v1）', async () => {
    fetchMock.mockResolvedValue(sseResponse([])) // url 断言在触发 fetch 后即可读
    await consumeChatStream('https://gw.example.com:11411').catch(() => undefined)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gw.example.com:11411/messages',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('流式 url 已含 /v1 只拼 /messages（不重复补）', async () => {
    fetchMock.mockResolvedValue(sseResponse([]))
    await consumeChatStream('https://gw.example.com:11411/v1').catch(() => undefined)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gw.example.com:11411/v1/messages',
      expect.anything(),
    )
  })

  it('fullUrl=true 完全不拼接（URL 原样访问，仅去尾斜杠）', async () => {
    fetchMock.mockResolvedValue(sseResponse([]))
    await consumeChatStream('https://gw.example.com:11411', true).catch(() => undefined)
    expect(fetchMock).toHaveBeenCalledWith('https://gw.example.com:11411', expect.anything())
  })

  it('伪 200（text/html 网关 SPA 回退）→ validation 配置错误', async () => {
    fetchMock.mockResolvedValue(
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    await expect(consumeChatStream('https://gw.example.com:11411')).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(ClassifiedError)
        const e = err as ClassifiedError
        expect(e.category).toBe('validation')
        expect(e.userMessage).toContain('大脑配置可能有误')
        return true
      },
    )
  })

  it('空流（event-stream 0 事件即关闭）→ provider 空流错误', async () => {
    fetchMock.mockResolvedValue(sseResponse([]))
    await expect(consumeChatStream('https://gw.example.com:11411/v1')).rejects.toSatisfy(
      (err: unknown) => {
        const e = err as ClassifiedError
        expect(e.category).toBe('provider')
        expect(e.userMessage).toContain('响应流为空')
        return true
      },
    )
  })

  it('正常事件流（message_start → message_stop）→ 正常 yield 并停止', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
    )
    const events = await consumeChatStream('https://gw.example.com:11411/v1')
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      'message_start',
      'message_stop',
    ])
  })

  it.each([
    [400, 'validation', ErrorId.BRAIN_HTTP_REQUEST_REJECTED],
    [401, 'auth', ErrorId.BRAIN_HTTP_AUTH_REJECTED],
    [403, 'auth', ErrorId.BRAIN_HTTP_AUTH_REJECTED],
    [408, 'timeout', ErrorId.BRAIN_HTTP_REQUEST_REJECTED],
    [429, 'provider', ErrorId.BRAIN_HTTP_RATE_LIMITED],
    [500, 'provider', ErrorId.BRAIN_HTTP_SERVICE_FAILED],
    [503, 'provider', ErrorId.BRAIN_HTTP_SERVICE_FAILED],
  ] as const)('HTTP %i 在 chat 和 chatStream 保留错误身份', async (status, category, errorId) => {
    for (const streaming of [false, true]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
        type: 'error', error: { type: 'api_error', message: 'controlled upstream failure' },
      }), { status, headers: { 'content-type': 'application/json' } }))
      const request = streaming
        ? consumeChatStream(options.url)
        : getLLMAdapter('anthropic')!.chat(buildProbeMessages(), [], { ...options, skipHooks: true })
      await expect(request).rejects.toMatchObject({
        name: 'ClassifiedError', category, errorId, source: 'brain',
        message: `upstream HTTP ${status}`, detail: `HTTP ${status}`,
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    { type: 'api_error', message: 'upstream generation failed' },
    { type: 'overloaded_error', message: 'overloaded' },
  ])('HTTP 200 JSON error $type 不能成为成功响应', async (error) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'error', error }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    await expect(getLLMAdapter('anthropic')!.chat(buildProbeMessages(), [], {
      ...options, skipHooks: true,
    })).rejects.toMatchObject({
      category: 'provider', source: 'brain', errorId: ErrorId.BRAIN_HTTP_SERVICE_FAILED,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  const partialEvents = [
    { type: 'message_start', message: { id: 'partial', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'not finished' } },
  ]
  const encodeEvent = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`

  it.each([false, true])('SSE error（已有部分输出=%s）必须抛错且释放 reader', async (partial) => {
    const events = partial ? partialEvents : []
    const cancel = vi.fn()
    const encoder = new TextEncoder()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          ...events, { type: 'error', error: { type: 'overloaded_error', message: 'upstream failed' } },
          { type: 'message_stop' },
        ].map(encodeEvent).join('')))
        // 保持传输打开：必须由适配器失败路径取消，而不是自然 EOF。
      },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const stream = await getLLMAdapter('anthropic')!.chatStream(buildProbeMessages(), [], {
      ...options, skipHooks: true,
    })
    const seen: unknown[] = []
    await expect((async () => {
      for await (const event of stream) seen.push(event)
    })()).rejects.toMatchObject({
      category: 'provider', source: 'brain', errorId: ErrorId.BRAIN_HTTP_SERVICE_FAILED,
    })
    expect(seen).toHaveLength(events.length)
    expect(seen).toMatchObject(events)
    expect(cancel).toHaveBeenCalledOnce()
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(true)
  })

  it.each([
    ['message_start', partialEvents.slice(0, 1)],
    ['部分文字', partialEvents],
    ['message_delta 带 stop_reason 但无 message_stop', [
      ...partialEvents,
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]],
  ])('EOF 在 %s 后关闭但无 message_stop 不能算完成', async (_label, events) => {
    fetchMock.mockResolvedValueOnce(sseResponse(events.map(encodeEvent)))
    await expect(consumeChatStream(options.url)).rejects.toMatchObject({
      category: 'validation', source: 'brain',
      detail: expect.stringContaining('message_stop'),
    })
  })

  it('合法 message_stop 主动结束、取消打开的流，不消费其后错误帧', async () => {
    const cancel = vi.fn()
    const terminalEvents = [...partialEvents, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' }]
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        const wire = [...terminalEvents, { type: 'error', error: { message: 'after terminal' } }]
          .map(encodeEvent).join('')
        // 刻意切开 data/JSON 边界，覆盖跨传输片段的行缓冲。
        const bytes = new TextEncoder().encode(wire)
        controller.enqueue(bytes.slice(0, 17))
        controller.enqueue(bytes.slice(17))
      },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const events = await consumeChatStream(options.url)
    expect(events.map((event) => (event as { type: string }).type))
      .toEqual(terminalEvents.map((event) => event.type))
    expect(cancel).toHaveBeenCalledOnce()
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal!.aborted).toBe(true)
  })

  it('非流式 content-type 非 JSON → validation 配置错误', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const llm = getLLMAdapter('anthropic')!
    await expect(
      llm.chat(buildProbeMessages() as never, [], { ...options, skipHooks: true }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as ClassifiedError
      expect(e.category).toBe('validation')
      expect(e.userMessage).toContain('大脑配置可能有误')
      return true
    })
  })
})

describe('Anthropic Message Adapter', () => {
  beforeEach(() => {
    registerAnthropicAdapter()
  })

  it('thinking(raw) 拼接所有 thinking 块文本', () => {
    const raw = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'A', signature: 'sig-A' },
        { type: 'text', text: 'visible' },
        { type: 'thinking', thinking: 'B', signature: 'sig-B' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never
    const adapter = getMessageAdapter('anthropic')!
    expect(adapter.thinking?.(raw)).toBe('AB')
  })

  it('thinkingBlocks(raw) 返回完整块（含 signature）', () => {
    const raw = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'A', signature: 'sig-A' },
        { type: 'text', text: 'visible' },
        { type: 'thinking', thinking: 'B', signature: 'sig-B' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never
    const adapter = getMessageAdapter('anthropic')!
    expect(adapter.thinkingBlocks?.(raw)).toEqual([
      { type: 'thinking', thinking: 'A', signature: 'sig-A' },
      { type: 'thinking', thinking: 'B', signature: 'sig-B' },
    ])
  })

  it('thinkingBlocks(raw) 包含 redacted_thinking 块', () => {
    const raw = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'visible', signature: 'sig' },
        { type: 'redacted_thinking', data: 'opaque-payload' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never
    const adapter = getMessageAdapter('anthropic')!
    expect(adapter.thinkingBlocks?.(raw)).toEqual([
      { type: 'thinking', thinking: 'visible', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque-payload' },
    ])
  })

  it('thinkingBlocks(raw) 无相关块时返回 undefined', () => {
    const raw = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'no thinking' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never
    const adapter = getMessageAdapter('anthropic')!
    expect(adapter.thinkingBlocks?.(raw)).toBeUndefined()
  })

  it('extractStreamDelta 仅取 text_delta', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamDelta({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      } as never),
    ).toBe('hi')
    expect(
      adapter.extractStreamDelta({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'x' },
      } as never),
    ).toBe('')
  })

  it('extractStreamThinking 仅取 thinking_delta', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamThinking?.({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'reasoning...' },
      } as never),
    ).toBe('reasoning...')
  })
})

describe('Anthropic extractStreamThinkingBlocks', () => {
  beforeEach(() => registerAnthropicAdapter())

  it('content_block_start(thinking) → start delta', () => {
    const adapter = getMessageAdapter('anthropic')!
    const result = adapter.extractStreamThinkingBlocks?.({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking' },
    } as never)
    expect(result).toEqual([{ kind: 'start', index: 0, type: 'thinking' }])
  })

  it('content_block_start(redacted_thinking) → start delta', () => {
    const adapter = getMessageAdapter('anthropic')!
    const result = adapter.extractStreamThinkingBlocks?.({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking' },
    } as never)
    expect(result).toEqual([{ kind: 'start', index: 1, type: 'redacted_thinking' }])
  })

  it('content_block_start(text/tool_use) → []（过滤）', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamThinkingBlocks?.({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      } as never),
    ).toEqual([])
    expect(
      adapter.extractStreamThinkingBlocks?.({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'x', name: 'y', input: {} },
      } as never),
    ).toEqual([])
  })

  it('thinking_delta → text delta（拼接文本）', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamThinkingBlocks?.({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'partial' },
      } as never),
    ).toEqual([{ kind: 'text', index: 0, text: 'partial' }])
  })

  it('signature_delta → signature delta（核心：必须捕获）', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamThinkingBlocks?.({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-xyz' },
      } as never),
    ).toEqual([{ kind: 'signature', index: 0, signature: 'sig-xyz' }])
  })

  it('content_block_stop → stop delta', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamThinkingBlocks?.({
        type: 'content_block_stop',
        index: 0,
      } as never),
    ).toEqual([{ kind: 'stop', index: 0 }])
  })

  it('其它事件（message_start/ping/message_delta）→ []', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(adapter.extractStreamThinkingBlocks?.({ type: 'ping' } as never)).toEqual([])
    expect(
      adapter.extractStreamThinkingBlocks?.({ type: 'message_start', message: {} } as never),
    ).toEqual([])
  })

  it('input_json_delta → []（不是 thinking）', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamThinkingBlocks?.({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      } as never),
    ).toEqual([])
  })
})

describe('Anthropic buildMessages — thinking blocks round-trip', () => {
  beforeEach(() => registerAnthropicAdapter())

  it('assistant + thinkingBlocks → blocks 原样还原（thinking+signature）', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hi',
        createdAt: 0,
        updateAt: 0,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'visible text',
        thinkingBlocks: [
          { type: 'thinking', thinking: 'reasoning A', signature: 'sig-A' },
          { type: 'thinking', thinking: 'reasoning B', signature: 'sig-B' },
        ],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history)
    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning A', signature: 'sig-A' },
          { type: 'thinking', thinking: 'reasoning B', signature: 'sig-B' },
          { type: 'text', text: 'visible text' },
        ],
      },
    ])
  })

  it('assistant + redacted_thinking → 原样还原（official=true 时）', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'visible',
        thinkingBlocks: [
          { type: 'thinking', thinking: 'seen', signature: 'sig' },
          { type: 'redacted_thinking', data: 'opaque-blob' },
        ],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history, undefined, { anthropicOfficial: true })
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: 'seen', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque-blob' },
      { type: 'text', text: 'visible' },
    ])
  })

  it('assistant 带 senseCalls + thinkingBlocks → thinking 排在 tool_use 之前', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        thinkingBlocks: [{ type: 'thinking', thinking: 'plan', signature: 'sig' }],
        senseCalls: [{ id: 'sc1', name: 'search', arguments: '{"q":"x"}' }],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history)
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      {
        type: 'tool_use',
        id: 'sc1',
        name: 'search',
        input: { q: 'x' },
      },
    ])
  })

  it('legacy fallback: 只有 thinking 字符串无 blocks → emit 无 signature 的 thinking 块', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'visible',
        thinking: 'old-style thinking text',
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history)
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content[0]).toEqual({
      type: 'thinking',
      thinking: 'old-style thinking text',
    })
    // legacy 不带 signature → API 必拒（文档化为已知限制）
    expect((assistant.content[0] as { signature?: string }).signature).toBeUndefined()
  })

  it('thinkingBlocks 优先于 thinking 字符串', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'visible',
        thinking: 'old',
        thinkingBlocks: [{ type: 'thinking', thinking: 'new', signature: 'sig' }],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history)
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'new', signature: 'sig' })
  })

  it('official=false（默认）→ strip redacted_thinking 块（兼容 3rd-party）', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'visible',
        thinkingBlocks: [
          { type: 'thinking', thinking: 'seen', signature: 'sig' },
          { type: 'redacted_thinking', data: 'opaque-blob' },
        ],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history, undefined, { anthropicOfficial: false })
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: 'seen', signature: 'sig' },
      { type: 'text', text: 'visible' },
    ])
    // redacted_thinking 应被 strip
    expect(
      assistant.content.find((b: { type?: string }) => b.type === 'redacted_thinking'),
    ).toBeUndefined()
  })

  it('official=true → 保留 redacted_thinking 块（完整 Anthropic 协议）', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'visible',
        thinkingBlocks: [
          { type: 'thinking', thinking: 'seen', signature: 'sig' },
          { type: 'redacted_thinking', data: 'opaque-blob' },
        ],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history, undefined, { anthropicOfficial: true })
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: 'seen', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque-blob' },
      { type: 'text', text: 'visible' },
    ])
  })

  it('buildOptions 缺省时 strip redacted_thinking（默认 safe 行为）', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'visible',
        thinkingBlocks: [{ type: 'redacted_thinking', data: 'opaque' }],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history)
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content).toEqual([{ type: 'text', text: 'visible' }])
  })

  it('assistant 只有 thinking 无 content → 只 emit thinking 块（无空 text 兜底）', () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        thinkingBlocks: [{ type: 'thinking', thinking: 'just thinking', signature: 'sig' }],
        createdAt: 0,
        updateAt: 0,
      },
    ]
    const result = adapter.buildMessages(history)
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: 'just thinking', signature: 'sig' },
    ])
  })

  it("assistant 纯空（无 content/thinking/blocks）→ [{text:''}] 兜底", () => {
    const adapter = getMessageAdapter('anthropic')!
    const history: LLMResponse[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 0, updateAt: 0 },
      { id: 'a1', role: 'assistant', content: '', createdAt: 0, updateAt: 0 },
    ]
    const result = adapter.buildMessages(history)
    const assistant = result.messages[1] as { content: unknown[] }
    expect(assistant.content).toEqual([{ type: 'text', text: '' }])
  })
})

describe('ThinkingBlockAssembler + extractStreamThinkingBlocks 端到端', () => {
  beforeEach(() => registerAnthropicAdapter())

  it('完整 SSE 序列 → 累积器产出完整 blocks', () => {
    const adapter = getMessageAdapter('anthropic')!
    const assembler = new ThinkingBlockAssembler()
    const events: unknown[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Hello ' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'world' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-X' },
      },
      { type: 'content_block_stop', index: 0 },
      // 第二块：redacted_thinking
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking' } },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'opaque' },
      },
      { type: 'content_block_stop', index: 1 },
    ]
    for (const ev of events) {
      const ops = adapter.extractStreamThinkingBlocks?.(ev as never) ?? []
      for (const op of ops) assembler.push(op)
    }
    expect(assembler.toArray()).toEqual([
      { type: 'thinking', thinking: 'Hello world', signature: 'sig-X' },
      { type: 'redacted_thinking', data: 'opaque' },
    ])
  })

  it('extractStreamThinkingBlocks 与 sense deltas 互不干扰', () => {
    const adapter = getMessageAdapter('anthropic')!
    expect(
      adapter.extractStreamThinkingBlocks?.({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
      } as never),
    ).toEqual([])
    // extractSenseCallDeltas 应能正常提取 tool_use
    // （通过同 chunk 类型，但由 senseAdapter 处理；此处只验证 thinking 不会误提取）
  })
})

describe('Anthropic server_tool_use / tool_result 与 GLM web_search_20250305', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    registerAnthropicAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('非流式响应解析 server_tool_use + tool_result，不进入本地 senseCalls，且脱敏 URL 参数', () => {
    const messageAdapter = getMessageAdapter('anthropic')!
    const raw = {
      id: 'msg_srv_1',
      type: 'message',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_01',
          name: 'webReader',
          input: { url: 'https://example.com/doc?token=abc123&lang=zh' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'srvtoolu_01',
          content: [{ type: 'text', text: '{"title":"Example Doc","content":"Hello"}' }],
        },
        {
          type: 'text',
          text: '文档标题是 Example Doc。',
        },
      ],
    }

    expect(messageAdapter.stopReason?.(raw as never)).toBe('end_turn')
    const serverCalls = messageAdapter.serverToolCalls?.(raw as never)
    expect(serverCalls).toEqual([
      {
        id: 'srvtoolu_01',
        name: 'webReader',
        arguments: '{"url":"https://example.com/doc?token=%5BREDACTED%5D&lang=zh"}',
        executionOwner: 'server',
        status: 'completed',
        protocol: 'anthropic-messages',
        responseId: 'msg_srv_1',
        index: 0,
        result: '{"title":"Example Doc","content":"Hello"}',
      },
    ])
  })

  it('GLM 模型在 Anthropic 协议下将 web_search 映射为 web_search_20250305', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_glm',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const llm = getLLMAdapter('anthropic')!
    await llm.chat(
      buildProbeMessages(),
      [
        {
          type: 'function',
          function: {
            name: 'web_search',
            description: 'search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        },
      ],
      {
        ...options,
        model: 'co-glm-5.3',
        skipHooks: true,
      },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { tools: unknown[] }
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }])
  })
})
