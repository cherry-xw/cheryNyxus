import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatAnthropicServerToolResult,
  registerAnthropicAdapter,
  sanitizeServerToolArgs,
  sanitizeServerToolText,
} from '@/agent/provider/anthropic.js'
import { registerOpenAIResponsesAdapter } from '@/agent/provider/openaiResponses.js'
import { getMessageAdapter } from '@/core/message/adapter.js'
import { getSenseAdapter } from '@/core/sense/adapter.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { mergeServerToolDeltas } from '@/agent/middleware/checkpointState.js'

beforeEach(() => {
  registerAnthropicAdapter()
  registerOpenAIResponsesAdapter()
})
afterEach(() => vi.unstubAllGlobals())

describe('已保存的真实搜索事件', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/server-tools-observed.json', import.meta.url), 'utf8'),
  )

  it('GLM 嵌套数组字符串恢复 9 个来源，保持真实工具名与调用 ID', () => {
    const adapter = getMessageAdapter('anthropic')!
    const deltas = fixture.glm.flatMap(
      (event: unknown) => adapter.extractStreamServerToolDeltas!(event) ?? [],
    )
    const calls = mergeServerToolDeltas(deltas)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: 'call_c1e48af4e3b2495b96a2a47b',
      name: 'web_search_prime',
      status: 'completed',
    })
    expect(calls[0]?.sources).toHaveLength(9)
    expect(
      calls[0]?.sources?.filter((source) => new URL(source.url).hostname === 'docs.bigmodel.cn'),
    ).toHaveLength(4)
    expect(
      getSenseAdapter('anthropic')!.senseCalls({
        content: fixture.glm.map((event: { content_block: unknown }) => event.content_block),
      }),
    ).toEqual([])
  })

  it('GPT 最终事件恢复真实 web_search_call，3 条注解形成 2 个不重复来源', () => {
    const adapter = getMessageAdapter('openai-responses')!
    const calls = adapter.serverToolCalls!(fixture.gpt.response)!
    const streamed = mergeServerToolDeltas(adapter.extractStreamServerToolDeltas!(fixture.gpt)!)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: 'ws_0c066885564063b2016ad2bdb823e087d0b9d5687fa6f4ddf1',
      name: 'web_search_call',
      status: 'completed',
    })
    expect(calls[0]?.sources).toHaveLength(2)
    expect(streamed).toEqual(calls)
    expect(getSenseAdapter('openai-responses')!.senseCalls(fixture.gpt.response)).toEqual([])
  })
})

describe('服务端工具展示数据保护', () => {
  it('递归清除嵌套凭据、URL 用户信息、签名参数和 Base64，不修改原始对象', () => {
    const input = {
      nested: [
        {
          api_key: 'private-key',
          headers: { Authorization: 'Bearer private-auth' },
          image: 'data:image/png;base64,cHJpdmF0ZQ==',
          url: 'https://user:password@example.com/a?token=private-token&lang=zh',
        },
      ],
    }
    const clean = sanitizeServerToolArgs(input)
    expect(clean).not.toMatch(/private-|password|cHJpdmF0ZQ==/)
    expect(JSON.parse(clean).nested[0]).toMatchObject({
      api_key: '[REDACTED]',
      headers: { Authorization: '[REDACTED]' },
    })
    expect(clean).toContain('lang=zh')
    expect(input.nested[0]!.api_key).toBe('private-key')
  })

  it('普通结果文字与未完成 JSON 中的已接收凭据同样脱敏', () => {
    expect(
      sanitizeServerToolText('读取失败 https://example.com/?api_key=private-token'),
    ).not.toContain('private-token')
    expect(sanitizeServerToolText('{"token":"private-incomplete')).toBe('{"token":"[REDACTED]')
  })

  it('结构化图片结果不把原始 Base64 和其他云存储签名保存为展示文字', () => {
    const image = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'private-image-bytes',
        url: 'https://example.com/source?sig=private-source-signature',
      },
      url: 'https://example.com/image?X-Goog-Signature=private-signature',
    }
    for (const content of [image, [image, { type: 'text', text: '说明' }]]) {
      const result = formatAnthropicServerToolResult(content)
      expect(result.text).not.toContain('private-')
      expect(result.text).toContain('[REDACTED]')
    }
  })

  it('从文本块内的嵌套 JSON 搜索结果提取来源，并清除结果正文中的凭据', () => {
    const formatted = formatAnthropicServerToolResult([
      {
        type: 'text',
        text: JSON.stringify({
          results: [
            [
              {
                title: 'Official',
                link: 'https://example.com/doc?sig=private-signature',
                content: 'result',
              },
            ],
          ],
        }),
      },
    ])
    expect(formatted.sources).toEqual([
      { url: 'https://example.com/doc?sig=%5BREDACTED%5D', title: 'Official', snippet: 'result' },
    ])
    expect(formatted.text).not.toContain('private-signature')
  })

  it('保留没有凭据的普通文字，不把非 JSON 结果当成解析失败', () => {
    expect(formatAnthropicServerToolResult('原始网页正文')).toEqual({ text: '原始网页正文' })
  })
})

describe('Anthropic 服务端异常与流式分流', () => {
  it('结构化错误不依赖 is_error，并在流式/非流式中保持失败状态', () => {
    const adapter = getMessageAdapter('anthropic')!
    const result = {
      type: 'web_search_tool_result',
      tool_use_id: 'server-1',
      content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
    }
    const raw = {
      id: 'message-1',
      content: [{ type: 'server_tool_use', id: 'server-1', name: 'web_search', input: {} }, result],
    }
    expect(adapter.serverToolCalls!(raw)[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('max_uses_exceeded'),
    })
    expect(
      adapter.extractStreamServerToolDeltas!({
        type: 'content_block_start',
        index: 1,
        content_block: result,
      })![0],
    ).toMatchObject({ status: 'failed', error: expect.stringContaining('max_uses_exceeded') })
  })

  it('孤立结果在流式与非流式均为未知，不补造成功开始', () => {
    const adapter = getMessageAdapter('anthropic')!
    const result = { type: 'tool_result', tool_use_id: 'orphan', content: 'result' }
    const streamed = mergeServerToolDeltas(
      adapter.extractStreamServerToolDeltas!({
        type: 'content_block_start',
        index: 2,
        content_block: result,
      })!,
    )
    expect(streamed[0]).toMatchObject({ id: 'orphan', status: 'unknown', result: 'result' })
    expect(adapter.serverToolCalls!({ id: 'msg', content: [result] })[0]).toMatchObject({
      id: 'orphan',
      status: 'unknown',
      result: 'result',
    })
  })

  it('真实 SSE 读取按 block index 分开普通与服务端分段参数', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg', content: [] } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'local', name: 'web_fetch', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"url":"https://example.com"}' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'server', name: 'webReader', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"url":"https://example.com?token=private-token"}',
        },
      },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_result', tool_use_id: 'server', content: 'page content' },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]
    const fetchMock = vi.fn(
      async () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const chunks = await getLLMAdapter('anthropic')!.chatStream(
      { system: null, messages: [] },
      [],
      { model: 'test', url: 'https://example.invalid/v1', key: 'test', skipHooks: true },
    )
    const messages = getMessageAdapter('anthropic')!
    const senses = getSenseAdapter('anthropic')!
    const serverDeltas = []
    const localDeltas = []
    for await (const chunk of chunks) {
      serverDeltas.push(...(messages.extractStreamServerToolDeltas!(chunk) ?? []))
      localDeltas.push(...senses.extractSenseCallDeltas(chunk))
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(localDeltas).toHaveLength(2)
    expect(localDeltas.map((delta) => delta.index)).toEqual([0, 0])
    expect(mergeServerToolDeltas(serverDeltas)).toMatchObject([
      {
        id: 'server',
        name: 'webReader',
        status: 'completed',
        result: 'page content',
        arguments: '{"url":"https://example.com/?token=%5BREDACTED%5D"}',
      },
    ])
  })
})

describe('Responses 状态不能由输出结束推定成功', () => {
  it.each(['failed', 'incomplete', undefined])('output_item.done 保留 %s 工具状态', (status) => {
    const adapter = getMessageAdapter('openai-responses')!
    const deltas = adapter.extractStreamServerToolDeltas!({
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'web_search_call', id: 'search-1', status },
    })!
    expect(mergeServerToolDeltas(deltas)[0]?.status).toBe(
      status === 'failed' ? 'failed' : 'unknown',
    )
  })

  it.each(['failed', 'incomplete', undefined])(
    'response.completed 不把 %s 工具状态改成成功',
    (status) => {
      const adapter = getMessageAdapter('openai-responses')!
      const raw = {
        id: 'response-1',
        status: 'completed',
        output: [{ type: 'web_search_call', id: 'search-1', status }],
      }
      const deltas = adapter.extractStreamServerToolDeltas!({
        type: 'response.completed',
        response: raw,
      })!
      const expected = status === 'failed' ? 'failed' : 'unknown'
      expect(adapter.serverToolCalls!(raw)[0]?.status).toBe(expected)
      expect(mergeServerToolDeltas(deltas)[0]?.status).toBe(expected)
    },
  )

  it('重复最终快照不新增调用或把已完成记录退回开始状态', () => {
    const adapter = getMessageAdapter('openai-responses')!
    const event = {
      type: 'response.completed',
      response: {
        id: 'response-1',
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            id: 'search-1',
            status: 'completed',
            action: { type: 'search', query: 'test' },
          },
        ],
      },
    }
    const deltas = adapter.extractStreamServerToolDeltas!(event)!
    expect(mergeServerToolDeltas([...deltas, ...deltas])).toMatchObject([
      { id: 'search-1', status: 'completed' },
    ])
    expect(mergeServerToolDeltas([...deltas, ...deltas])).toHaveLength(1)
  })
})
