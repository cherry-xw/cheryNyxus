import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBuilder } from '@/agent/builder.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import {
  getMockProviderTranscript,
  resetMockProviderState,
} from '@/agent/provider/mock.js'
import { configureRetryTimingForTests } from '@/agent/middleware/retry.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import {
  collectChunks,
  collectContent,
  firstError,
  hasDone,
  senseAccepts,
  senseEnds,
} from '@test/agent/helpers/chunkAssert.js'

let restoreRetryTiming: (() => void) | undefined

beforeAll(async () => {
  await bootstrapAgentRuntime()
})

beforeEach(() => {
  resetMockProviderState()
})

afterEach(() => {
  restoreRetryTiming?.()
  restoreRetryTiming = undefined
})

function createAgent(brain: string, senseGroup: string, chatId = randomUUID()): AgentBuilder {
  return new AgentBuilder()
    .build()
    .configureRuntime(
      { brain, senseGroup, mcpServers: [] },
      true,
      undefined,
      chatId,
      'protocol_leader',
    )
    .init(chatId)
}

describe('Mock Provider full interaction scenarios', () => {
  it('runs user input -> Mock LLM -> final response through the real middleware', async () => {
    const agent = createAgent('protocol_content', 'protocol_none', 'chat-content')
    const chunks = await collectChunks(agent.run('hello protocol'))

    expect(collectContent(chunks)).toContain('protocol content response')
    expect(hasDone(chunks)).toBe(true)
    expect(getMockProviderTranscript()).toEqual([
      expect.objectContaining({
        model: 'protocol_content',
        chatId: 'chat-content',
        turn: 0,
        attempt: 1,
        outcome: 'response',
      }),
    ])
  })

  it('executes a real read_file tool and feeds its result into the next model turn', async () => {
    const agent = createAgent('protocol_read_file', 'protocol_files', 'chat-read-file')
    const chunks = await collectChunks(agent.run('read the isolated fixture'))

    expect(senseEnds(chunks)).toEqual([
      expect.objectContaining({ name: 'read_file', id: expect.any(String) }),
    ])
    expect(senseAccepts(chunks)[0]).toMatchObject({
      name: 'read_file',
      result: expect.stringContaining('PROTOCOL_FIXTURE_READ_OK'),
    })
    expect(collectContent(chunks)).toContain('isolated fixture read completed')
    expect(getMockProviderTranscript().map((entry) => entry.turn)).toEqual([0, 1])
    expect(getMockProviderTranscript()[0]?.toolNames).toEqual(['read_file'])
  })

  it('retries network and timeout failures without sleeping, then succeeds on attempt three', async () => {
    const sleeps: number[] = []
    restoreRetryTiming = configureRetryTimingForTests({
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      random: () => 0.5,
    })
    const agent = createAgent('protocol_retry', 'protocol_none', 'chat-retry')
    const chunks = await collectChunks(agent.run('retry this turn'))

    expect(firstError(chunks)).toBeUndefined()
    expect(collectContent(chunks)).toContain('retry recovered on attempt three')
    expect(sleeps).toEqual([1000, 2000])
    expect(getMockProviderTranscript()).toEqual([
      expect.objectContaining({ chatId: 'chat-retry', attempt: 1, outcome: 'error' }),
      expect.objectContaining({ chatId: 'chat-retry', attempt: 2, outcome: 'error' }),
      expect.objectContaining({ chatId: 'chat-retry', attempt: 3, outcome: 'response' }),
    ])
  })

  it('does not retry authentication or validation-class failures', async () => {
    const sleep = vi.fn(async () => {})
    restoreRetryTiming = configureRetryTimingForTests({ sleep, random: () => 0.5 })
    const agent = createAgent('protocol_auth_failure', 'protocol_none', 'chat-auth')
    const chunks = await collectChunks(agent.run('authenticate'))
    const error = firstError(chunks)

    expect(error?.errors).toHaveLength(1)
    expect(error?.errors[0]).toMatchObject({ category: 'auth', recoverable: false, attempt: 1 })
    expect(sleep).not.toHaveBeenCalled()
    expect(getMockProviderTranscript()).toHaveLength(1)
  })

  it('isolates script cursors by chat even when both chats use the same model', async () => {
    const first = createAgent('protocol_content', 'protocol_none', 'chat-a')
    const second = createAgent('protocol_content', 'protocol_none', 'chat-b')

    const [firstChunks, secondChunks] = await Promise.all([
      collectChunks(first.run('first')),
      collectChunks(second.run('second')),
    ])

    expect(collectContent(firstChunks)).toContain('protocol content response')
    expect(collectContent(secondChunks)).toContain('protocol content response')
    expect(getMockProviderTranscript().map(({ chatId, turn, attempt }) => ({
      chatId,
      turn,
      attempt,
    }))).toEqual([
      { chatId: 'chat-a', turn: 0, attempt: 1 },
      { chatId: 'chat-b', turn: 0, attempt: 1 },
    ])
  })

  it('fails loudly when strict-mode script turns are exhausted', async () => {
    const adapter = getLLMAdapter('mock')
    expect(adapter).toBeDefined()

    const exhaustedHistory = [
      { id: 'assistant-1', role: 'assistant', content: 'already consumed' },
    ]
    await expect(
      adapter!.chat(exhaustedHistory, [], {
        model: 'protocol_content',
        chatId: 'chat-exhausted',
      }),
    ).rejects.toThrow('Mock script exhausted')
  })
})
