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
})
