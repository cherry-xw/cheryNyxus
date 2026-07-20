import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAnthropicAdapter } from '@/agent/provider/anthropic.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter, type LLMResponse } from '@/core/message/adapter.js'

const { mockDispatch } = vi.hoisted(() => ({
  mockDispatch: vi.fn(async () => undefined),
}))

vi.mock('@/agent/hooks/index.js', () => ({ dispatch: mockDispatch }))

const fetchMock = vi.fn()
const options = {
  model: 'claude-test',
  url: 'https://api.anthropic.com',
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
})
