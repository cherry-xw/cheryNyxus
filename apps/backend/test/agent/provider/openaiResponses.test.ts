import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmProtocol } from '@chery/protocol'
import { registerOpenAIResponsesAdapter } from '@/agent/provider/openaiResponses.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter } from '@/core/message/adapter.js'
import { getSenseAdapter } from '@/core/sense/adapter.js'

describe('OpenAI Responses adapter', () => {
  beforeEach(() => {
    registerOpenAIResponsesAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('注册独立协议 adapter', () => {
    expect(getLLMAdapter(LlmProtocol.OPENAI_RESPONSES)).toBeDefined()
    expect(getMessageAdapter(LlmProtocol.OPENAI_RESPONSES)).toBeDefined()
    expect(getSenseAdapter(LlmProtocol.OPENAI_RESPONSES)).toBeDefined()
  })

  it('请求 /responses 并使用 input 与 reasoning 参数', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            output: [
              { type: 'reasoning', summary: [{ type: 'summary_text', text: '先判断。' }] },
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'OK' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const llm = getLLMAdapter(LlmProtocol.OPENAI_RESPONSES)!
    const result = await llm.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'MiniMax-M3',
      url: 'https://example.com/v1',
      key: 'k',
      thinkingParams: { reasoning: { effort: 'none' } },
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.com/v1/responses')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'MiniMax-M3',
      input: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'none' },
    })
    const messages = getMessageAdapter(LlmProtocol.OPENAI_RESPONSES)!
    expect(messages.content(result)).toBe('OK')
    expect(messages.thinking?.(result)).toBe('先判断。')
  })

  it('解析 function_call 并构造历史 function_call_output', () => {
    const sense = getSenseAdapter(LlmProtocol.OPENAI_RESPONSES)!
    expect(
      sense.senseCalls({
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"a"}',
          },
        ],
      }),
    ).toEqual([
      {
        index: 0,
        id: 'call_1',
        name: 'read_file',
        arguments: '{"path":"a"}',
      },
    ])

    const messages = getMessageAdapter(LlmProtocol.OPENAI_RESPONSES)!
    expect(
      messages.buildMessages([
        {
          id: 'call_1',
          role: 'sense',
          content: 'file content',
          createdAt: 1,
          updateAt: 1,
        },
      ]),
    ).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: 'file content' }])
  })

  it('可选参数工具不强制启用 Responses strict schema', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ output: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const sense = {
      definition: {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'read a file',
          parameters: {
            type: 'object' as const,
            properties: {
              path: { type: 'string' },
              limit: { type: 'number' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      executor: { schema: {} as never, execute: async () => ({ content: '' }) },
      supervisionLevel: undefined,
    }
    const built = getSenseAdapter(LlmProtocol.OPENAI_RESPONSES)!.buildSenses([sense] as never)
    const llm = getLLMAdapter(LlmProtocol.OPENAI_RESPONSES)!

    await llm.chat([{ role: 'user', content: 'read it' }], built, {
      model: 'gpt-6-luna',
      url: 'https://example.com/v1',
      key: 'k',
    })

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      tools: Array<{ strict: boolean }>
    }
    expect(body.tools[0]?.strict).toBe(false)
  })

  it('DeepSeek 多轮历史把思考编码为 reasoning item', () => {
    const messages = getMessageAdapter(LlmProtocol.OPENAI_RESPONSES)!
    expect(
      messages.buildMessages(
        [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '可见回答',
            thinking: '历史思考',
            createdAt: 1,
            updateAt: 1,
          },
          {
            id: 'user-2',
            role: 'user',
            content: '继续',
            createdAt: 2,
            updateAt: 2,
          },
        ],
        undefined,
        { reasoningHistory: 'reasoning-item' },
      ),
    ).toEqual([
      {
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: '历史思考' }],
      },
      { role: 'assistant', content: '可见回答' },
      { role: 'user', content: '继续' },
    ])
  })

  it('GPT 模型在 Responses 协议下将 web_search 映射为内置 web_search 工具，并解析 web_search_call 与 url_citation', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_ws_1',
            status: 'completed',
            output: [
              {
                id: 'ws_01',
                type: 'web_search_call',
                status: 'completed',
                action: {
                  type: 'search',
                  query: 'OpenAI Responses API web_search_call',
                  queries: ['OpenAI Responses API web_search_call'],
                },
              },
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: '根据官方文档说明……',
                    annotations: [
                      {
                        type: 'url_citation',
                        url: 'https://developers.openai.com/api/docs/guides/tools-web-search?api_key=secret',
                        title: 'Web search | OpenAI API',
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const llm = getLLMAdapter(LlmProtocol.OPENAI_RESPONSES)!
    const raw = await llm.chat(
      [{ role: 'user', content: 'search' }],
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
        model: 'gpt-6.1-sol',
        url: 'https://example.com/v1',
        key: 'k',
      },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { tools: unknown[] }
    expect(body.tools).toEqual([{ type: 'web_search', external_web_access: true }])

    const messages = getMessageAdapter(LlmProtocol.OPENAI_RESPONSES)!
    expect(messages.stopReason?.(raw)).toBe('completed')
    expect(messages.serverToolCalls?.(raw)).toEqual([
      {
        id: 'ws_01',
        name: 'web_search_call',
        arguments: JSON.stringify({
          type: 'search',
          query: 'OpenAI Responses API web_search_call',
          queries: ['OpenAI Responses API web_search_call'],
        }),
        executionOwner: 'server',
        status: 'completed',
        protocol: 'openai-responses',
        responseId: 'resp_ws_1',
        index: 0,
        result:
          '搜索查询：OpenAI Responses API web_search_call\n来源引用（1）：\n1. Web search | OpenAI API - https://developers.openai.com/api/docs/guides/tools-web-search?api_key=%5BREDACTED%5D',
        sources: [
          {
            url: 'https://developers.openai.com/api/docs/guides/tools-web-search?api_key=%5BREDACTED%5D',
            title: 'Web search | OpenAI API',
          },
        ],
      },
    ])
  })
})
